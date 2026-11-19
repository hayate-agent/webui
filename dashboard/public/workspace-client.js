import { openActionMenu } from './ui/menu.jsx';
import { openWorkspaceDialog } from './ui/dialog.jsx';
import { createComposer } from './ui/composer.jsx';
import { createMediaDrafts, uploadImageChunks } from './media-drafts.js';
import { renderChatMessage } from './ui/message.jsx';
import { setupMobileNavigation } from './mobile-nav.js';
import { createSessionCard } from './ui/session-card.jsx';
import { settleReceipts } from './receipts.js';
import { renderContextMeter } from './ui/context-meter.jsx';
import { rowButtonClass, headingButtonClass, iconButtonClass } from './ui/button-class.js';
// Optional frontend projection. No project/agent/secret domain state is stored here.
import { createLiveTransport } from './live-transport.js';
import { discoverAgent } from './agent-discovery.js';
import { createHistoryViewport } from './history-viewport.js';
import { createRefreshHealth } from './refresh-health.js';
import { createStreamState } from './stream-state.js';
import { createCommandChannel } from './command-channel.js';
import { appendNewer, prependOlder } from './history-window.js';
import { createChatCache } from './chat-cache.js';
import { createNavigation } from './navigation.js';
export { discoverAgent };

export async function mountWorkspace({ request, notice, markdown }) {
  const capabilitiesRequested = Date.now();
  const capabilities = await request('/api/workspace/capabilities');
  // Server clock offset for opId issue times (midpoint estimate).
  const serverOffsetMs = Number.isFinite(capabilities.serverTime) ? capabilities.serverTime - (capabilitiesRequested + Date.now()) / 2 : 0;
  if (capabilities.workspaces !== 1) return;
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const run = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(e => notice(e.message));
  const button = (text, fn) => { const e = node('button', text); e.type = 'button'; e.title = text; e.onclick = run(fn); return e; };
  let state, projectId, streamId, events, visible = false;
  let remoteSelection, remoteRefreshing = false, browsingAgent, resyncStream = false;
  let localHistory;
  const clearLocalHistory = () => { localHistory?.viewport.destroy(); localHistory = undefined; };
  const clearRemote = () => { remoteSelection?.viewport?.destroy(); remoteSelection = undefined; clearLocalHistory(); connectionStatus.hidden = true; meterSlot?.replaceChildren(); };
  let agentRoster = [], navigationRevision = 0, peerState, sending = false, management = false;
  const newest = (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) || a.id.localeCompare(b.id);
  const remoteProjects = new Map(), agentSnapshots = new Map();
  const chatCache = createChatCache();
  const visibilityKey = 'workspace.hidden-agents';
  let hiddenAgents = new Set();
  try { const saved = JSON.parse(localStorage.getItem(visibilityKey) ?? '[]'); if (Array.isArray(saved)) hiddenAgents = new Set(saved.filter(id => typeof id === 'string')); } catch { /* Invalid preferences must not prevent loading chats. */ }
  // One preference set for three levels. Agent ids are stored unchanged (older
  // browsers keep working); projects and chats are `project:<agent>:<id>` / `chat:<agent>:<id>`.
  const hideKey = (kind, agentId, id) => `${kind}:${agentId ?? 'local'}:${id}`;
  const isHidden = (kind, agentId, id) => hiddenAgents.has(hideKey(kind, agentId, id));
  function setAgentHidden(id, hidden) {
    const next = new Set(hiddenAgents); if (hidden) next.add(id); else next.delete(id);
    try { localStorage.setItem(visibilityKey, JSON.stringify([...next])); } catch { notice('Sidebar preference could not be saved; it will apply until reload.'); }
    hiddenAgents = next; renderTree();
  }
  async function newAgentChat(id) {
    agentPicker.value = id; await agentPicker.onchange(); input.focus();
  }
  // Mutations: WebSocket command with opId + ack, POST fallback with the same
  // opId (one server ledger). Older backends keep the plain POST.
  let commands;
  const peerRequest = (agentId, capability, input) => {
    const read = ['list', 'read', 'resolve', 'submission-status', 'fork-eligibility', 'changes'].includes(input.action) || input.action === 'pi-chats' && ['list', 'preview'].includes(input.operation);
    if (read && capabilities['browser-live-v1'] === 1) return request(`/api/workspace/agents/${agentId}/read?${new URLSearchParams({ capability, input: JSON.stringify(input) })}`);
    if (capabilities['browser-commands-v1'] === 1) {
      commands ??= createCommandChannel({ serverOffsetMs, transport: { command: () => false }, post: frame => request(`/api/workspace/agents/${frame.agentId}/request`, { opId: frame.opId, capability: frame.capability, input: frame.input }) });
      return commands.run({ agentId, capability, input });
    }
    return request(`/api/workspace/agents/${agentId}/request`, { capability, input });
  };
  const panel = node('section', undefined, 'workspace-screen'); panel.hidden = true;
  const heading = node('header'); const headingText = node('h1', 'New chat');
  const menu = button('⋮', event => globalMenu(event)); menu.setAttribute('aria-label', 'Workspace settings');
  const agentLabel = node('label', 'Agent'); agentLabel.className = 'agent-picker';
  const agentPicker = node('select'); agentPicker.setAttribute('aria-label', 'Active agent'); agentLabel.append(agentPicker);
  const projectLabel = node('label', 'Project (optional)'); projectLabel.className = 'agent-picker';
  const projectPicker = node('select'); projectPicker.setAttribute('aria-label', 'Chat project'); projectLabel.append(projectPicker);
  const chatContext = node('p', '', 'workspace-context'); chatContext.hidden = true;
  const headingIdentity = node('div', undefined, 'chat-heading-identity'); const meterSlot = node('div', undefined, 'chat-heading-meter'); headingIdentity.append(headingText, chatContext, meterSlot);
  const headingControls = node('div', undefined, 'chat-heading-controls'); headingControls.append(agentLabel, projectLabel, menu);
  heading.append(headingIdentity, headingControls);
  projectPicker.onchange = run(() => selectProject(projectPicker.value || undefined));
  const errorBox = node('p', '', 'workspace-error'); errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
  const legacyNotice = notice; notice = message => { legacyNotice(message); errorBox.textContent = message ?? ''; errorBox.hidden = !message; };
  const body = node('section', undefined, 'workspace-content');
  const { host: composerHost, composer, input, send, piMode, piStop, attach, files, attachments } = createComposer();
  const mediaDrafts = createMediaDrafts();
  const supportsImages = () => remoteSelection
    ? !!agentSnapshots.get(remoteSelection.agentId)?.streams?.find(stream => stream.id === remoteSelection.streamId)?.features?.includes('image-prompt-v1')
    : !!state?.streams?.find(stream => stream.id === streamId)?.features?.includes('image-prompt-v1');
  function renderAttachments() {
    attach.hidden = !supportsImages();
    attachments.replaceChildren();
    for (const item of mediaDrafts.list(activeDraftKey)) {
      const row = node('div'); const image = node('img'); image.src = item.url; image.alt = item.file.name; image.width = 80; image.height = 80;
      row.append(image, button(`Remove ${item.file.name}`, () => { mediaDrafts.remove(activeDraftKey, item.id); renderAttachments(); })); attachments.append(row);
    }
  }
  const addImages = selected => { if (!supportsImages()) { notice('This agent does not yet support image uploads. Your files were not sent.'); return; } try { mediaDrafts.add(activeDraftKey, selected); renderAttachments(); } catch (error) { notice(error.message); } };
  attach.onclick = () => files.click();
  files.onchange = () => { addImages(files.files); files.value = ''; };
  input.addEventListener('paste', event => { const images = [...event.clipboardData.files]; if (images.length) { event.preventDefault(); addImages(images); } });
  composer.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  composer.addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); addImages(event.dataTransfer.files); } });
  const drafts = new Map(), acceptedMessages = new Map();
  let activeDraftKey;
  const draftKey = () => remoteSelection ? JSON.stringify(['remote', remoteSelection.agentId, remoteSelection.streamId]) : JSON.stringify([browsingAgent ?? 'local', streamId ?? 'new', projectId ?? null]);
  const storeDraft = () => { if (activeDraftKey) drafts.set(activeDraftKey, { text: input.value, mode: piMode.value }); };
  const syncDraft = () => {
    const key = draftKey(); if (key === activeDraftKey) { renderAttachments(); return; }
    storeDraft(); activeDraftKey = key;
    const draft = drafts.get(key); input.value = draft?.text ?? ''; piMode.value = draft?.mode ?? 'followUp'; input.disabled = false; renderAttachments();
  };
  input.addEventListener('input', storeDraft); piMode.addEventListener('change', storeDraft);
  const clearSentDraft = (key, text) => {
    if (activeDraftKey === key) storeDraft();
    if (drafts.get(key)?.text.trim() === text) { drafts.delete(key); if (activeDraftKey === key) input.value = ''; }
  };
  // History proof of delivery (see showRemote). Never resends: it only forgets the
  // attempt whose identity matches the message that the agent itself reports.
  function reconcileDelivered(agentId, remoteId, receipt) {
    let changed = false;
    for (const [key, attempt] of attempts) if (attempt.id === receipt.id && key.endsWith(`:${agentId}:${remoteId}`)) { attempts.delete(key); changed = true; }
    if (changed) sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
    const draftId = JSON.stringify(['remote', agentId, remoteId]);
    if (drafts.get(draftId)?.text.trim() === receipt.text) { drafts.delete(draftId); if (activeDraftKey === draftId) { input.value = ''; send.disabled = sending; } }
    if (/WebUI operation failed|acceptance unknown|retry with the same/i.test(errorBox.textContent)) notice('');
  }
  piStop.onclick = run(async () => {
    if (!remoteSelection) return;
    await peerRequest(remoteSelection.agentId, 'messages', { action: 'pi', route: `/api/pi/sessions/${remoteSelection.streamId}/abort`, body: {} });
    await showRemote(remoteSelection);
  });
  panel.append(heading, errorBox, body, composerHost);
  const legacyMain = document.querySelector('main'); legacyMain.after(panel);
  setupMobileNavigation([heading, legacyMain.querySelector('header')]);
  const tree = node('nav', undefined, 'workspace-tree'); tree.hidden = true; tree.setAttribute('aria-label', 'Projects and streams'); $('chats').after(tree);
  async function showWorkspace(value) {
    visible = value; legacyMain.hidden = visible; panel.hidden = !visible; tree.hidden = !visible; $('chats').hidden = visible;
    if (visible) { await refresh(); beginEvents(); }
    else { events?.close(); agentPicker.value = 'local'; }
  }
  $('new').textContent = '＋ New chat';
  $('new').onclick = run(async () => { management = false; navigationRevision++; streamId = undefined; clearRemote(); projectId = undefined; browsingAgent = undefined; peerState = undefined; navigation.show({ kind: 'home' }); renderTree(); renderTargets(); renderDashboard(); beginEvents(); input.focus(); });
  $('search').oninput = () => renderTree();
  // Hash navigation: the address names the selection; back/forward/reload restore it.
  const navigation = createNavigation({ open: async route => {
    if (route.kind === 'home') { $('new').onclick(); return; }
    if (route.kind === 'chat' && route.agent === 'local') { if (state.streams.some(stream => stream.id === route.id)) await selectStream(route.id); else $('new').onclick(); return; }
    if (route.kind === 'chat') { if (!agentRoster.some(agent => agent.id === route.agent)) return; browsingAgent = route.agent; peerState = agentSnapshots.get(route.agent); await selectRemote(route.agent, route.id); return; }
    if (route.kind === 'agent') { if (agentPicker.value === route.agent && browsingAgent === route.agent) return; if (![...agentPicker.options].some(option => option.value === route.agent)) return; agentPicker.value = route.agent; await agentPicker.onchange(); return; }
    if (route.kind === 'project') {
      if (route.agent === 'local') { browsingAgent = undefined; peerState = undefined; agentPicker.value = 'local'; if (!state.projects.some(project => project.id === route.id)) { $('new').onclick(); return; } }
      else { if (!agentRoster.some(agent => agent.id === route.agent)) return; browsingAgent = route.agent; peerState = agentSnapshots.get(route.agent); }
      await selectProject(route.id);
    }
  } });
  async function refreshAgents() {
    if (capabilities['agent-hub'] === 1) agentRoster = (await request('/api/workspace/agents')).agents;
    agentPicker.replaceChildren();
    const local = node('option', capabilities['local-agent'] === false ? 'Choose an agent' : state.agent); local.value = 'local'; local.disabled = capabilities['local-agent'] === false; agentPicker.append(local);
    for (const agent of agentRoster) { const option = node('option', agent.name); option.value = agent.id; agentPicker.append(option); }
    agentPicker.value = browsingAgent ?? 'local';
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, agentRoster.length) }, async () => {
      while (index < agentRoster.length) {
        const agent = agentRoster[index++];
        try {
          const snapshot = await discoverAgent((capability, input) => peerRequest(agent.id, capability, input));
          agent.features = snapshot.features ?? [];
          agentSnapshots.set(agent.id, snapshot);
        } catch { agentSnapshots.set(agent.id, { projects: [], streams: [], unavailable: true }); }
      }
    }));
    renderTree();
  }
  agentPicker.onchange = run(async () => {
    management = false; navigationRevision++;
    const id = agentPicker.value;
    peerState = undefined; projectId = undefined; streamId = undefined;
    if (id === 'local') { browsingAgent = undefined; clearRemote(); navigation.show({ kind: 'home' }); render(); beginEvents(); return; }
    browsingAgent = id; clearRemote(); streamId = undefined; projectId = undefined; navigation.show({ kind: 'agent', agent: id });
    renderTree(); renderTargets(); headingText.textContent = 'New chat'; body.replaceChildren(node('p', 'Loading conversations…'));
    try { await showAgentStreams(id); } catch (error) {
      const agent = agentRoster.find(agent => agent.id === id); const option = [...agentPicker.options].find(option => option.value === id);
      if (option) option.textContent = `${agent?.name ?? 'Agent'} · unavailable`;
      body.replaceChildren(node('p', `${agent?.name ?? 'Agent'} is unavailable. No work was sent.`)); throw error;
    }
  });
  async function showAgentStreams(id) {
    const revision = navigationRevision;
    const agent = agentRoster.find(agent => agent.id === id);
    const [snapshot, projects] = await Promise.all([peerRequest(id, 'streams', { action: 'list' }), peerRequest(id, 'projects', { action: 'list' })]);
    if (revision !== navigationRevision) return;
    if (agent) agent.features = Array.isArray(snapshot.features) ? snapshot.features : [];
    const projection = { ...snapshot, projects: projects.projects ?? [] };
    agentSnapshots.set(id, projection);
    if (browsingAgent === id) peerState = projection;
    renderTree(); renderTargets();
    if (browsingAgent === id && !remoteSelection) renderDashboard();
  }
  async function refresh() { state = await request('/api/workspace/state'); render(); }
  async function change(kind, id, patch) { await request(`/api/workspace/${kind}/${id}`, patch); await refresh(); }
  function beginEvents() {
    events?.close();
    const current = events = new EventSource(`/api/workspace/events${streamId ? `?stream=${encodeURIComponent(streamId)}` : ''}`);
    const interrupted = 'Workspace connection interrupted; reconnecting without resubmitting work.';
    const recovered = () => {
      if (events === current && errorBox.textContent === interrupted) notice('');
    };
    current.onopen = recovered;
    current.onmessage = event => {
      if (events !== current) return;
      recovered();
      const next = JSON.parse(event.data); state = next;
      renderTree(); if (management) return; renderTargets();
      if (remoteSelection || browsingAgent) return;
      if (streamId && next.conversation?.id === streamId) renderConversation(next.conversation);
      else if (!streamId) renderDashboard();
    };
    current.onerror = () => { if (visible && events === current) notice(interrupted); };
  }
  let treeSignature;
  function renderTree() {
    const signature = JSON.stringify({ state, hiddenAgents: [...hiddenAgents], agents: agentRoster, snapshots: [...agentSnapshots], query: $('search').value, projectId, streamId, remoteSelection: remoteSelection && { agentId: remoteSelection.agentId, streamId: remoteSelection.streamId }, browsingAgent });
    if (signature === treeSignature) return;
    treeSignature = signature;
    const scrollTop = tree.scrollTop, scrollLeft = tree.scrollLeft;
    const fragment = document.createDocumentFragment();
    if (capabilities['project-creation'] !== false) fragment.append(button('＋ New project', () => projectDialog()));
    if (capabilities['agent-hub'] === 1) fragment.append(button('Agents', agentsDialog));
    if (hiddenAgents.size) fragment.append(button('Hidden items…', () => dialog('Sidebar visibility', d => {
      const agents = [...(capabilities['local-agent'] !== false ? [{ id: 'local', name: state.agent }] : []), ...agentRoster];
      const sourceOf = id => id === 'local' ? state : agentSnapshots.get(id);
      for (const key of [...hiddenAgents]) {
        const [kind, owner, ...rest] = key.split(':'), id = rest.join(':');
        if (!['project', 'chat'].includes(kind) || !id) { const agent = agents.find(item => item.id === key); if (agent) d.append(button(`Show agent ${agent.name}`, () => { setAgentHidden(key, false); d.close(); })); continue; }
        const source = sourceOf(owner), item = (kind === 'chat' ? source?.streams : source?.projects)?.find(entry => entry.id === id);
        d.append(button(`Show ${kind} ${item?.title ?? id}`, () => { setAgentHidden(key, false); d.close(); }));
      }
    })));
    if (capabilities['local-agent'] !== false && !hiddenAgents.has('local')) fragment.append(renderAgentTree(state, undefined, state.agent));
    for (const agent of agentRoster.filter(agent => !hiddenAgents.has(agent.id))) fragment.append(renderAgentTree(agentSnapshots.get(agent.id) ?? { projects: [], streams: [] }, agent.id, agent.name));
    tree.replaceChildren(fragment);
    tree.scrollTop = scrollTop; tree.scrollLeft = scrollLeft;
  }
  function renderAgentTree(source, agentId, name) {
    const fragment = node('section', undefined, 'workspace-agent-group'); fragment.dataset.agentId = agentId ?? 'local';
    const choose = () => { agentPicker.value = agentId ?? 'local'; agentPicker.onchange(); };
    const header = node('div', undefined, 'workspace-agent-header workspace-agent-heading-row');
    const label = button(name, choose); label.className = 'workspace-agent-heading';
    const add = button('+', () => newAgentChat(agentId ?? 'local')); add.setAttribute('aria-label', `New chat with ${name}`); add.title = `New chat with ${name}`;
    const more = button('⋮', event => popup(event, [
      ...(agentId && source.features?.includes('pi-chat-bindings') ? [['Select PI sessions…', () => selectPiSessions(agentId)]] : []),
      ...(agentId ? [['Refresh chats', () => showAgentStreams(agentId)]] : []),
      ['New chat', () => newAgentChat(agentId ?? 'local')],
      ['Hide agent from sidebar', () => setAgentHidden(agentId ?? 'local', true)],
    ])); more.setAttribute('aria-label', `${source.features?.includes('pi-chat-bindings') ? 'Actions' : 'Settings'} for agent ${name}`);
    label.classList.add(...headingButtonClass.split(' ')); add.classList.add(...iconButtonClass.split(' ')); more.classList.add(...iconButtonClass.split(' '));
    header.append(label, add, more); fragment.append(header);
    if (source.unavailable) fragment.append(node('p', 'Unavailable', 'workspace-context'));
    if (source.incomplete) fragment.append(node('p', 'Partial discovery: some projects or conversations could not be loaded.', 'workspace-context'));
    const projects = source.projects.filter(p => !isHidden('project', agentId, p.id) && !p.deleted && !p.archived && !(p.importSource === 'webui' && p.title === 'Existing chats' && !p.parentId && !Object.keys(p.settings ?? {}).length && !source.projects.some(child => child.parentId === p.id)));
    const query = $('search').value.toLocaleLowerCase();
    const streams = source.streams.filter(s => !s.deleted && !s.archived && !isHidden('chat', agentId, s.id) && !isHidden('project', agentId, s.projectId) && !source.projects.some(p => p.id === s.projectId && (p.deleted || p.archived)));
    const matches = stream => stream.title.toLocaleLowerCase().includes(query);
    function row(stream) {
      const element = node('div', undefined, 'workspace-stream-row'); element.dataset.streamId = stream.id;
      const select = button(`${stream.unread ? '● ' : ''}${stream.title}`, () => agentId ? selectRemote(agentId, stream.id) : selectStream(stream.id));
      select.classList.add(...rowButtonClass.split(' '));
      select.setAttribute('aria-current', String(stream.id === (remoteSelection?.streamId ?? streamId)));
      const more = button('⋮', event => agentId ? remoteStreamMenu(stream, event, agentId, source) : streamMenu(stream, event)); more.setAttribute('aria-label', `Settings for ${stream.title}`); more.classList.add(...iconButtonClass.split(' '));
      element.append(select, more); element.oncontextmenu = event => { event.preventDefault(); if (agentId) remoteStreamMenu(stream, event, agentId, source); else streamMenu(stream, event); };
      element.draggable = !agentId;
      element.ondragstart = event => event.dataTransfer.setData('application/x-hayate-stream', stream.id);
      return element;
    }
    const activity = project => Math.max(project.updatedAt ?? 0, ...streams.filter(s => s.projectId === project.id).map(s => s.updatedAt ?? s.createdAt ?? 0));
    function children(parent = null, visited = new Set()) {
      const group = node('div', undefined, 'workspace-group');
      const entries = projects.filter(p => !visited.has(p.id) && (p.parentId === parent || (parent === null && !projects.some(other => other.id === p.parentId))));
      entries.sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
      for (const project of entries) {
        const details = node('details'); details.dataset.projectId = project.id;
        const key = `workspace.expand.${agentId ?? 'local'}.${project.id}`;
        details.open = !!query || sessionStorage.getItem(key) !== 'false';
        const members = streams.filter(s => s.projectId === project.id && matches(s)).sort(newest);
        const summary = node('summary');
        const label = button(`${members.some(s => s.unread) ? '● ' : ''}${project.title}`, () => { browsingAgent = agentId; peerState = agentId ? source : undefined; return selectProject(project.id); });
        const toggle = button(details.open ? '▾' : '▸', () => {});
        toggle.className = 'workspace-disclosure'; toggle.setAttribute('aria-label', `Expand or collapse ${project.title}`);
        toggle.onclick = event => { event.preventDefault(); details.open = !details.open; sessionStorage.setItem(key, String(details.open)); };
        details.ontoggle = () => { toggle.textContent = details.open ? '▾' : '▸'; toggle.setAttribute('aria-expanded', String(details.open)); };
        summary.append(label, toggle);
        if (agentId) {
          const more = button('⋮', event => popup(event, [['Hide project from sidebar', () => setAgentHidden(hideKey('project', agentId, project.id), true)]])); more.setAttribute('aria-label', `Settings for ${project.title}`); more.classList.add(...iconButtonClass.split(' ')); summary.append(more);
        }
        if (!agentId) {
          const more = button('⋮', event => projectMenu(project, event)); more.setAttribute('aria-label', `Settings for ${project.title}`); summary.append(more);
          summary.ondragover = event => { if (event.dataTransfer.types.includes('application/x-hayate-stream')) event.preventDefault(); };
          summary.ondrop = run(async event => { event.preventDefault(); await change('streams', event.dataTransfer.getData('application/x-hayate-stream'), { projectId: project.id }); });
        }
        details.append(summary, ...members.map(row), children(project.id, new Set([...visited, project.id]))); group.append(details);
      }
      return group;
    }
    const standalone = node('section', undefined, 'standalone-chats'); standalone.setAttribute('aria-label', 'Chats without project');
    standalone.append(...streams.filter(s => !projects.some(p => p.id === s.projectId) && matches(s)).sort(newest).map(row));
    if (!agentId) {
      standalone.ondragover = event => { if (event.dataTransfer.types.includes('application/x-hayate-stream')) event.preventDefault(); };
      standalone.ondrop = run(async event => { event.preventDefault(); await change('streams', event.dataTransfer.getData('application/x-hayate-stream'), { projectId: null }); });
      if (!standalone.childElementCount) standalone.append(node('p', 'Drop a chat here to remove its project.', 'workspace-context'));
    }
    fragment.append(children(), standalone); return fragment;
  }
  function renderTargets() {
    syncDraft();
    composer.hidden = management;
    if (management) { agentLabel.hidden = true; projectLabel.hidden = true; chatContext.hidden = true; return; }
    send.disabled = sending || remoteSelection?.stale === true || capabilities['local-agent'] === false && !browsingAgent && !remoteSelection;
    const existing = Boolean(streamId || remoteSelection);
    agentLabel.hidden = existing; projectLabel.hidden = existing; chatContext.hidden = !existing;
    const agentId = remoteSelection?.agentId ?? browsingAgent;
    agentPicker.value = agentId ?? 'local';
    const source = agentId ? agentSnapshots.get(agentId) : state;
    const none = node('option', 'No project'); none.value = '';
    projectPicker.replaceChildren(none, ...(source?.projects ?? []).filter(p => !p.deleted && !p.archived && p.importSource !== 'webui').map(p => { const option = node('option', p.title); option.value = p.id; return option; }));
    projectPicker.value = projectId ?? '';
    chatContext.textContent = `${agentId ? agentRoster.find(a => a.id === agentId)?.name ?? 'Remote agent' : state.agent}${projectId ? ' · ' + (source?.projects.find(p => p.id === projectId)?.title ?? 'Project') : ''}`;
  }
  function renderDashboard() {
    clearLocalHistory();
    const project = state.projects.find(p => p.id === projectId);
    headingText.textContent = project?.title ?? peerState?.projects?.find(p => p.id === projectId)?.title ?? 'New chat';
    const fragment = document.createDocumentFragment();
    const welcome = node('div', undefined, 'workspace-welcome');
    welcome.append(node('h2', 'What would you like to do today?'), node('p', 'Start a conversation. Organize it into a project whenever you want.'));
    fragment.append(welcome);

    body.replaceChildren(fragment);
  }
  function renderConversation(stream) {
    headingText.textContent = stream.title;
    const previousScrollTop = body.scrollTop;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
    const fragment = document.createDocumentFragment();
    if (localHistory?.id !== stream.id) {
      clearLocalHistory();
      localHistory = { id: stream.id, viewport: createHistoryViewport({ scroller: body, render: message => {
        const row = renderChatMessage(message, new Set(), markdown);
        if (message.accepted === false) row.append(node('small', 'Acceptance unconfirmed'), button('Retry safely', async () => {
          await request(`/api/workspace/streams/${stream.id}/messages`, { id: message.id, text: message.text });
          attempts.delete(stream.id); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
        }));
        return row;
      } }) };
    }
    fragment.append(localHistory.viewport.element);
    if (stream.activity) {
      if (stream.activity.text) { const preview = node('article', undefined, 'message assistant'); preview.append(markdown(stream.activity.text)); fragment.append(preview); }
      fragment.append(node('p', Object.entries(stream.activity.tools).filter(([, n]) => n).map(([name, n]) => `${name} ×${n}`).join(' · ') || 'Waiting for agent output…', 'workspace-context'));
    }
    body.replaceChildren(fragment);
    localHistory.viewport.update(stream.messages);
    body.scrollTop = nearBottom ? body.scrollHeight : previousScrollTop;
    localHistory.viewport.refresh();
    if (stream.unread) run(() => change('streams', stream.id, { read: true }))();
  }
  const refreshHealth = createRefreshHealth();
  const connectionStatus = node('span', '', 'workspace-context');
  connectionStatus.setAttribute('role', 'status');
  connectionStatus.hidden = true;
  chatContext.after(connectionStatus);
  let recoveryTimer;
  function refreshFailed(target, revision) {
    if (revision !== navigationRevision) return;
    const state = refreshHealth.failure(target);
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      if (revision === navigationRevision && target === JSON.stringify([browsingAgent, projectId, remoteSelection?.streamId])) void refreshRemote();
    }, state.delay + 1);
    connectionStatus.hidden = false;
    connectionStatus.textContent = `Connection interrupted · showing retained history · retry in ${Math.ceil(state.delay / 1000)}s. Draft kept; nothing resubmitted.`;
  }
  function refreshRecovered(target, revision) {
    if (revision !== navigationRevision) return;
    if (remoteSelection?.stale) { refreshFailed(target, revision); return; }
    clearTimeout(recoveryTimer);
    refreshHealth.success(target); connectionStatus.hidden = true;
  }
  let refreshPending = false;
  function refreshFinished() {
    remoteRefreshing = false;
    if (refreshPending) { refreshPending = false; queueMicrotask(() => void refreshRemote()); }
  }
  async function refreshRemote() {
    if (!visible || management || capabilities['agent-hub'] !== 1) return;
    if (remoteRefreshing) { refreshPending = true; return; }
    const target = JSON.stringify([browsingAgent, projectId, remoteSelection?.streamId]);
    const refreshRevision = navigationRevision;
    if (!refreshHealth.ready(target)) return;
    if (browsingAgent) {
      remoteRefreshing = true;
      try {
        // A selected conversation does not depend on refreshing the sidebar
        // catalog first. Read it directly; discovery has its own navigation path.
        if (remoteSelection) {
          if (remoteSelection.stream?.streaming) { if (resyncStream) { resyncStream = false; await remoteSelection.stream.resync(); } }
          else await showRemote(remoteSelection);
          refreshRecovered(target, refreshRevision);
          return;
        }
        const id = browsingAgent, revision = navigationRevision;
        const snapshot = await peerRequest(id, 'streams', { action: 'list' });
        if (id !== browsingAgent || revision !== navigationRevision) return;
        peerState = { ...peerState, ...snapshot }; agentSnapshots.set(id, peerState); renderTree();
        if (remoteSelection) await showRemote(remoteSelection);
        refreshRecovered(target, refreshRevision);
      } catch { refreshFailed(target, refreshRevision); } finally { refreshFinished(); }
      return;
    }
    if (!projectId) return;
    const selected = projectId; const selectedRemote = remoteSelection; remoteRefreshing = true;
    try {
      const snapshot = await request(`/api/workspace/projects/${selected}/agents`);
      remoteProjects.set(selected, snapshot);
      if (projectId !== selected) return;
      renderTree(); renderTargets();
      if (selectedRemote && remoteSelection === selectedRemote) {
        const agent = snapshot.agents.find(agent => agent.agentId === selectedRemote.agentId);
        if (agent?.status === 'connected') {
          // Streaming selection: repair from `changes`, never reload the transcript.
          if (selectedRemote.stream?.streaming) { if (resyncStream) { resyncStream = false; await selectedRemote.stream.resync(); } }
          else await showRemote(selectedRemote);
        }
        else { refreshFailed(target, refreshRevision); return; }
      } else if (!streamId && !remoteSelection) renderDashboard();
      refreshRecovered(target, refreshRevision);
    } catch { if (projectId === selected) refreshFailed(target, refreshRevision); }
    finally { refreshFinished(); }
  }
  // Streaming (stream-delta-v1): one bounded GET page, then pushed deltas only.
  // Rendering is coalesced to one frame; no transcript GET while the socket works.
  const streamingEnabled = capabilities['browser-stream-v1'] === 1;
  function startStreaming(selection, page) {
    if (!streamingEnabled || !page.stream?.epoch || page.stale) { selection.stream?.clear(); selection.stream = undefined; return; }
    selection.stream ??= createStreamState({
      fetchChanges: (session, since, epoch) => peerRequest(selection.agentId, 'messages', { action: 'changes', streamId: session, since, epoch }),
      // A reset (moved branch, lost window, new epoch) starts from a fresh page:
      // previously retained pages may belong to an obsolete branch.
      reload: () => { if (remoteSelection !== selection) return; selection.history = undefined; selection.before = undefined; selection.detached = false; return showRemote(selection); },
      onUpdate: () => scheduleStreamRender(selection),
      onError: () => { if (remoteSelection === selection) void showRemote(selection).catch(() => {}); },
    });
    selection.stream.reset(selection.streamId, page);
    // Events that arrived while this page was in flight: the page position was
    // captured before its snapshot, so replay them (duplicates are ignored by seq).
    for (const envelope of selection.recentEvents ?? []) if (envelope.epoch === page.stream.epoch) selection.stream.receive(envelope);
  }
  function scheduleStreamRender(selection) {
    if (selection.renderScheduled) return; selection.renderScheduled = true;
    requestAnimationFrame(() => {
      selection.renderScheduled = false;
      const view = selection.stream?.view; if (remoteSelection !== selection || !view || !selection.conversation) return;
      const activity = view.activity.busy || view.activity.text || view.activity.executions.length ? { text: view.activity.text, thinking: view.activity.thinking, executions: view.activity.executions, tools: {} } : null;
      const waiting = view.activity.waiting ? { text: view.activity.text, thinking: view.activity.thinking, executions: view.activity.executions, tools: { [`Waiting: ${view.activity.waiting}`]: 1 } } : activity;
      selection.conversation = { ...selection.conversation, messages: view.messages.slice(-256), usage: view.usage ?? selection.conversation.usage, busy: view.activity.busy, activity: waiting, dialogs: view.dialogs.filter(dialog => !dialog.expiresAt || dialog.expiresAt > Date.now()) };
      void showRemote(selection, true).catch(() => {});
    });
  }
  async function showRemote(selection, cached = false, warmPage) {
    const revision = selection.revision = (selection.revision ?? 0) + 1;
    const cacheKey = `${selection.agentId}:${selection.streamId}`;
    // First open of a chat in this tab: paint the last known page right away, then
    // let the authoritative read below replace it (stale-while-revalidate).
    if (!cached && !selection.conversation && !selection.painted) {
      selection.painted = true;
      const warm = chatCache.get(cacheKey);
      if (warm) { selection.warm = true; try { await showRemote(selection, true, warm); } finally { selection.warm = false; } if (remoteSelection !== selection) return; selection.signature = undefined; selection.stream?.clear?.(); selection.history = undefined; selection.before = undefined; selection.revision = revision; }
    }
    const conversation = cached && (selection.conversation || warmPage) ? { ...(warmPage ?? selection.conversation), messages: [...(warmPage ?? selection.conversation).messages] } : await peerRequest(selection.agentId, 'messages', { action: 'read', streamId: selection.streamId });
    if (!cached) chatCache.set(cacheKey, conversation);
    if (remoteSelection !== selection || selection.revision !== revision) return;
    if (!cached) startStreaming(selection, conversation);
    selection.conversation = conversation;
    const agent = remoteProjects.get(projectId)?.agents.find(agent => agent.agentId === selection.agentId) ?? agentRoster.find(agent => agent.id === selection.agentId);
    const knownTitle = agentSnapshots.get(selection.agentId)?.streams?.find(stream => stream.id === selection.streamId)?.title;
    headingText.textContent = knownTitle || conversation.title;
    if (/^(Target unavailable;|Agent refresh failed;)/.test(errorBox.textContent)) notice('');
    if (conversation.stale) {
      connectionStatus.hidden = false;
      connectionStatus.textContent = 'Connection interrupted · retained history is read-only until the owner reconnects. Draft kept; nothing resubmitted.';
    }
    selection.stale = conversation.stale === true;
    const isPi = agent?.features?.includes('pi-live-v1');
    piMode.hidden = !isPi; piStop.hidden = !isPi;
    input.disabled = conversation.readOnly === true; send.disabled = sending || conversation.readOnly === true;
    chatContext.hidden = !isPi;
    meterSlot.replaceChildren(...(isPi && conversation.usage ? [renderContextMeter(conversation.usage)] : []));
    if (isPi) chatContext.textContent = conversation.readOnly ? 'Saved PI history · no live owner connected' : conversation.busy ? 'PI working · steer, follow up or stop' : 'PI connected · idle';
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
    const oldScrollTop = body.scrollTop;
    const expanded = new Set([...body.querySelectorAll('details[open][data-disclosure-id]')].map(item => item.dataset.disclosureId));
    // Retained history is bounded (history-window.js). While the user browses
    // an older detached window, live pages are not merged across the gap.
    if (selection.history && selection.detached) {
      conversation.messages = selection.history; conversation.before = selection.before;
    } else if (selection.history) {
      const bounded = appendNewer(selection.history, selection.before, conversation.messages);
      conversation.messages = bounded.history; conversation.before = bounded.before;
    }
    selection.history = conversation.messages;
    selection.before = conversation.before;
    const receiptKey = JSON.stringify(['remote', selection.agentId, selection.streamId]);
    const accepted = acceptedMessages.get(receiptKey) ?? [];
    // Only the agent's own read proves delivery (see receipts.js); a cached page never does.
    const { pending: pendingAccepted, delivered } = settleReceipts(accepted, conversation.messages, { authoritative: !warmPage });
    // The agent's history contains these exact submissions: delivered even if the HTTP
    // answer failed. Drop the unresolved attempt and draft so the composer does not
    // keep (and re-offer) a message that is already in the chat.
    for (const receipt of delivered) reconcileDelivered(selection.agentId, selection.streamId, receipt);
    if (!warmPage) acceptedMessages.set(receiptKey, pendingAccepted);
    const signature = JSON.stringify([conversation, pendingAccepted]);
    if (selection.signature !== signature) {
      selection.signature = signature;
      const fragment = document.createDocumentFragment();
      if (conversation.dialogs?.length) for (const question of conversation.dialogs) {
        const field = node('fieldset', undefined, 'ui-question-card'); field.append(node('legend', question.title ?? 'PI question'));
        if (question.message) field.append(node('p', question.message, 'ui-question-message'));
        const answer = async value => {
          await peerRequest(selection.agentId, 'messages', { action: 'pi', route: `/api/pi/sessions/${selection.streamId}/dialog`, body: { id: question.id, answer: value } });
          await showRemote(selection);
        };
        if (question.method === 'confirm') field.append(button('Confirm', () => answer({ confirmed: true })), button('Decline', () => answer({ confirmed: false })));
        else if (question.method === 'select') for (const value of question.options ?? []) field.append(button(value, () => answer({ value })));
        else { const editor = node('textarea'); editor.value = question.prefill ?? ''; editor.placeholder = question.placeholder ?? ''; editor.setAttribute('aria-label', question.title ?? 'Answer PI'); field.append(editor, button('Answer PI', () => answer({ value: editor.value }))); }
        field.append(button('Cancel question', () => answer({ cancelled: true }))); fragment.append(field);
      }
      const renderMessage = message => renderChatMessage(message, expanded, markdown);
      const loadEarlier = async () => {
        if (!selection.before || selection.loadingEarlier) return;
        selection.loadingEarlier = true;
        try {
        const previous = await peerRequest(selection.agentId, 'messages', { action: 'read', streamId: selection.streamId, before: selection.before });
        if (remoteSelection !== selection) return;
        const bounded = prependOlder(selection.history, previous);
        selection.history = bounded.history; selection.before = bounded.before;
        if (bounded.detached && !selection.detached) { selection.detached = true; selection.signature = undefined; await showRemote(selection, true); return; }
        selection.viewport.update(selection.history);
        if (selection.earlier) selection.earlier.hidden = !selection.before;
        } catch (error) { notice(error.message); }
        finally { selection.loadingEarlier = false; }
      };
      const earlier = conversation.before ? button('Load earlier messages', loadEarlier) : null;
      selection.earlier = earlier;
      if (!selection.viewport) selection.viewport = createHistoryViewport({ render: renderMessage, scroller: body, onEarlier: loadEarlier });
      if (earlier) fragment.append(earlier);
      fragment.append(selection.viewport.element);
      if (selection.detached) fragment.append(button('Jump to latest messages', async () => { selection.history = undefined; selection.before = undefined; selection.detached = false; selection.signature = undefined; await showRemote(selection); }));
      for (const receipt of pendingAccepted) {
        const row = node('article', undefined, 'message user');
        row.append(node('p', receipt.text), node('small', receipt.unconfirmed ? 'Zustellung unbestätigt · wird nicht automatisch erneut gesendet' : receipt.mode === 'followUp' ? 'Follow-up eingereiht · wartet auf PI' : 'Angenommen · wartet auf PI-Verlauf', 'workspace-context'));
        fragment.append(row);
      }
      if (conversation.activity?.thinking) {
        const details = node('details'); details.dataset.disclosureId = 'live:thinking'; details.open = expanded.has(details.dataset.disclosureId);
        details.append(node('summary', 'Thinking…'), node('pre', conversation.activity.thinking)); fragment.append(details);
      }
      for (const tool of conversation.activity?.executions ?? []) {
        const details = node('details'); details.dataset.disclosureId = `live:${tool.id}`; details.open = expanded.has(details.dataset.disclosureId);
        details.append(node('summary', `${tool.name} · ${tool.status}${tool.durationMs != null ? ` · ${(tool.durationMs / 1000).toFixed(1)}s` : ''}`), node('pre', typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2))); fragment.append(details);
      }
      if (conversation.activity?.text) { const row = node('article', undefined, 'message assistant'); row.append(markdown(conversation.activity.text)); fragment.append(row); }
      if (conversation.activity) fragment.append(node('p', Object.entries(conversation.activity.tools ?? {}).filter(([, count]) => count).map(([name, count]) => `${name} ×${count}`).join(' · ') || 'Target is working…', 'workspace-context'));
      body.replaceChildren(fragment);
      // Re-attaching the viewport resets scrollTop; restore position only after the
      // rows were measured, otherwise estimates land the view in the middle.
      selection.viewport.update(selection.history);
      if (nearBottom) selection.viewport.scrollToEnd();
      else { body.scrollTop = oldScrollTop; selection.viewport.refresh(); }
    }
    if (conversation.unread && agent?.features?.includes('read-markers')) await peerRequest(selection.agentId, 'messages', { action: 'mark-read', streamId: selection.streamId });
  }
  async function selectRemote(agentId, id) {
    connectionStatus.hidden = true;
    clearLocalHistory();
    management = false; navigationRevision++;
    peerState = agentSnapshots.get(agentId);
    projectId = peerState?.streams?.find(s => s.id === id)?.projectId;
    remoteSelection?.viewport?.destroy();
    streamId = undefined; browsingAgent = agentId; remoteSelection = { agentId, streamId: id }; navigation.show({ kind: 'chat', agent: agentId, id }); renderTree(); renderTargets();
    await showRemote(remoteSelection); input.focus();
  }
  if (capabilities['browser-live-v1'] === 1) {
    const socketURL = new URL('/api/workspace/live', location.href); socketURL.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let invalidating = false, changedAgain = false;
    const synchronize = async (event = {}) => {
      // Streaming selection: deltas arrive on the socket and are never re-read.
      // With a negotiated stream, invalidations are only sent when an event
      // could not be delivered (or the roster changed). Each one is repaired by
      // a bounded `changes?since` read, never by a transcript reload.
      resyncStream = true;
      if (invalidating) { changedAgain = true; return; }
      invalidating = true;
      try { do { changedAgain = false; await refreshRemote(); } while (changedAgain && visible); }
      finally { invalidating = false; }
    };
    const onEvent = frame => {
      const selection = remoteSelection;
      if (!selection || frame.agentId !== selection.agentId || frame.envelope.session !== selection.streamId) return;
      // Bounded replay buffer for pages still in flight (see startStreaming).
      const recent = selection.recentEvents ??= [];
      recent.push(frame.envelope); if (recent.length > 256) recent.splice(0, recent.length - 256);
      selection.stream?.receive(frame.envelope);
    };
    let transport;
    if (capabilities['browser-commands-v1'] === 1) commands = createCommandChannel({ serverOffsetMs, transport: { command: frame => transport?.command(frame) ?? false }, post: frame => request(`/api/workspace/agents/${frame.agentId}/request`, { opId: frame.opId, capability: frame.capability, input: frame.input }) });
    transport = createLiveTransport({ socketURL: socketURL.href, revisionURL: '/api/workspace/revision', onChange: synchronize, onEvent, onAck: frame => commands?.receive(frame), onClose: () => commands?.disconnected() });
    transport.start();
    window.addEventListener('pagehide', () => transport.stop());
    window.addEventListener('pageshow', () => transport.start());
  } else setInterval(() => { if (!document.hidden) void refreshRemote(); }, 5000);
  function render() {
    renderTree(); if (management) return; renderTargets();
    if (remoteSelection) run(() => showRemote(remoteSelection))();
    else if (browsingAgent) run(() => showAgentStreams(browsingAgent))();
    else if (streamId) {
      const id = streamId, revision = navigationRevision;
      run(async () => { const conversation = await request(`/api/workspace/streams/${id}`); if (navigationRevision === revision && streamId === id && !browsingAgent) renderConversation(conversation); })();
    } else renderDashboard();
  }
  async function selectProject(id) { management = false; navigationRevision++; projectId = id; streamId = undefined; clearRemote(); navigation.show({ kind: 'project', agent: browsingAgent ?? 'local', id }); renderTree(); renderTargets(); renderDashboard(); beginEvents(); input.focus(); if (!browsingAgent) void refreshRemote(); }
  async function selectStream(id) {
    management = false; navigationRevision++;
    const stream = state.streams.find(s => s.id === id); if (!stream) return;
    projectId = stream.projectId; streamId = id; clearRemote(); browsingAgent = undefined; peerState = undefined; navigation.show({ kind: 'chat', agent: 'local', id }); render(); beginEvents(); input.focus();
  }
  function popup(event, items) {
    const anchor = event?.target?.closest('button') ?? event?.target;
    openActionMenu(anchor, items, error => notice(error.message), event?.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : undefined);
  }
  function dialog(title, build) {
    return openWorkspaceDialog(title, build);
  }
  function field(form, label, value = '', type = 'text') {
    const wrapper = node('label', label); const e = node('input'); e.type = type; e.value = value; wrapper.append(e); form.append(wrapper); return e;
  }
  function formDialog(title, build) {
    return dialog(title, d => { const form = node('form'); d.append(form); const save = build(form, d); const submit = node('button', 'Save'); submit.type = 'submit'; form.append(submit); form.onsubmit = event => { event.preventDefault(); if (submit.disabled) return; submit.disabled = true; run(async () => { try { await save(); } finally { submit.disabled = false; } })(); }; });
  }
  function chooseDirectory(done) {
    const d = dialog('Server directories', d => { d.append(node('p', 'Only operator-allowed server roots are shown. This does not grant project-code trust.')); });
    const list = node('div'); d.append(list);
    async function show(path) {
      const response = await request(`/api/workspace/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      list.replaceChildren();
      if (response.roots) for (const root of response.roots) list.append(button(root, () => show(root)));
      else {
        list.append(node('p', response.directory), button('Use this directory', () => { done(response.directory); d.close(); }));
        if (response.parent) list.append(button('↑ Parent', () => show(response.parent)));
        for (const entry of response.entries) list.append(button(entry.name + '/', () => show(entry.path)));
      }
    }
    run(() => show())();
  }
  function projectDialog(parentId = null) {
    formDialog('New project', (form, d) => {
      const name = field(form, 'Project name'); name.required = true;
      const cwd = field(form, 'Primary server directory'); cwd.required = true;
      form.append(button('Choose directory…', () => chooseDirectory(p => { cwd.value = p; })));
      const additional = field(form, 'Additional directories (one per line)');
      const repositories = new Set();
      if (capabilities['git-catalog'] === 1) form.append(button('Choose Git repositories…', () => gitPicker((entry, primary) => {
        if (!entry.directory) { notice('This repository has no operator-configured local checkout. Configure a checkout mapping before using it as execution context.'); return; }
        repositories.add(entry.directory);
        additional.value = [...new Set([...additional.value.split('\n').filter(Boolean), entry.directory])].join('\n');
        if (primary) cwd.value = entry.directory;
      })));
      return async () => { const project = await request('/api/workspace/projects', { title: name.value, cwd: cwd.value, parentId, directories: additional.value.split('\n').filter(Boolean), repositories: [...repositories] }); d.close(); await refresh(); await selectProject(project.id); };
    });
  }
  function gitPicker(select) {
    dialog('Git repositories', d => {
      const content = node('div'); d.append(content);
      const showRepositories = async (provider, organization, page = 1) => {
        const result = await request(`/api/workspace/git/${provider}/repositories?page=${page}${organization ? `&organization=${encodeURIComponent(organization)}` : ''}`);
        for (const entry of result.entries) {
          const row = node('div'); row.append(node('span', `${entry.name}${entry.directory ? '' : ' · no local checkout'}`), button('Use as primary', () => select(entry, true)), button('Add repository', () => select(entry, false))); content.append(row);
        }
        if (result.hasMore) content.append(button('More repositories', () => showRepositories(provider, organization, page + 1)));
      };
      run(async () => {
        const { providers } = await request('/api/workspace/git');
        for (const provider of providers) content.append(button(provider.id, async () => {
          content.replaceChildren(button('My repositories', () => showRepositories(provider.id)));
          const organizations = await request(`/api/workspace/git/${provider.id}/organizations`);
          for (const org of organizations.entries) content.append(button(org.name, () => showRepositories(provider.id, org.name)));
          if (organizations.hasMore) content.append(node('p', 'Additional organization pages are available through the backend catalog command/API.'));
        }));
      })();
    });
  }
  function streamDialog(project) {
    formDialog('New chat', (form, d) => {
      const name = field(form, 'Chat name', 'New chat');
      const directory = node('select'); directory.setAttribute('aria-label', 'Execution directory');
      for (const p of project.directories) { const o = node('option', p); o.value = p; directory.append(o); } form.append(directory);
      return async () => { const stream = await request('/api/workspace/streams', { projectId: project.id, title: name.value, cwd: directory.value }); d.close(); await refresh(); await selectStream(stream.id); };
    });
  }
  function settingsDialog(kind, object) {
    formDialog(`${kind} settings`, (form, d) => {
      const values = object?.settings ?? state.settings;
      const name = kind === 'global' ? undefined : field(form, 'Name', object.title);
      const model = field(form, 'Model reference (empty = inherit)', values.model ?? '');
      const thinking = field(form, 'Reasoning value supported by selected model (empty = inherit)', values.thinking ?? '');
      const instructions = field(form, 'Instructions', values.instructions ?? '');
      return async () => {
        const settings = Object.fromEntries(Object.entries({ model: model.value, thinking: thinking.value, instructions: instructions.value }).filter(([, value]) => value));
        if (kind === 'global') await request('/api/workspace/settings', settings);
        else await change(kind === 'project' ? 'projects' : 'streams', object.id, { title: name.value, settings });
        d.close(); await refresh();
      };
    });
  }
  function conversationDetails(conversation, agentName) {
    dialog('Conversation details', d => {
      const list = node('dl');
      for (const [label, value] of [['Agent', agentName], ['Chat', conversation.title], ['Execution directory', conversation.cwd]]) {
        list.append(node('dt', label), node('dd', value ?? 'Not available'));
      }
      d.append(list);
    });
  }
  function projectMenu(project, event) {
    const items = [
      ['Settings', () => settingsDialog('project', project)],
      ['New chat', () => streamDialog(project)],
      ['New subproject', () => projectDialog(project.id)],
      ['Archive', () => change('projects', project.id, { archived: true })],
      ['Delete (recoverable)', async () => { if (confirm('Hide this project without deleting history?')) await change('projects', project.id, { deleted: true }); }],
    ];
    if (capabilities['agent-hub'] === 1) items.splice(3, 0, ['Share settings with agents', async () => {
      const { results } = await request(`/api/workspace/projects/${project.id}/sync`, {});
      dialog('Sharing results', d => d.append(node('pre', results.length ? results.map(result => `${result.agent}: ${result.ok ? 'applied' : result.error}`).join('\n') : 'No connected agents.')));
    }]);
    items.push(['Hide project from sidebar', () => setAgentHidden(hideKey('project', undefined, project.id), true)]);
    popup(event, items);
  }
  const forkAttempts = new Map();
  async function forkChat(stream, agentId) {
    const features = agentSnapshots.get(agentId)?.features ?? agentRoster.find(agent => agent.id === agentId)?.features ?? [];
    if (agentId && features.includes('fork-eligibility-v1')) {
      const eligibility = await peerRequest(agentId, 'streams', { action: 'fork-eligibility', streamId: stream.id });
      if (!eligibility.eligible) {
        notice(eligibility.reason || 'This session cannot be forked yet.');
        return;
      }
    }
    const key = `${agentId ?? 'local'}:${stream.id}`;
    const idempotencyKey = forkAttempts.get(key) ?? crypto.randomUUID();
    forkAttempts.set(key, idempotencyKey);
    const fork = agentId
      ? await peerRequest(agentId, 'streams', { action: 'fork', streamId: stream.id, idempotencyKey })
      : await request(`/api/workspace/streams/${stream.id}/fork`, { idempotencyKey });
    forkAttempts.delete(key);
    if (agentId) { await showAgentStreams(agentId); await selectRemote(agentId, fork.id); }
    else { await refresh(); await selectStream(fork.id); }
  }
  function streamMenu(stream, event) {
    popup(event, [

      ['Settings', () => settingsDialog('stream', stream)],
      ['Details', () => conversationDetails(stream, state.agent)],
      ['Rename chat', () => formDialog('Rename chat', (form, d) => {
        const name = document.createElement('input'); name.value = stream.title; name.required = true; name.maxLength = 160; name.setAttribute('aria-label', 'Chat name'); form.append(name);
        return async () => { await change('streams', stream.id, { title: name.value.trim() }); d.close(); };
      })],
      ['Fork chat', () => forkChat(stream)],
      ['Move to project…', () => popup(event, state.projects.filter(p => !p.deleted && !p.archived && p.importSource !== 'webui').map(p => [p.title, () => change('streams', stream.id, { projectId: p.id })]))],
      ['Remove from project', () => change('streams', stream.id, { projectId: null })],
      ['Convert to project', async () => { const p = await request(`/api/workspace/streams/${stream.id}/convert`, {}); await refresh(); await selectProject(p.id); }],
      ['Archive', () => change('streams', stream.id, { archived: true })],
      ['Delete (recoverable)', async () => { if (confirm('Hide this chat without deleting history or cancelling work?')) await change('streams', stream.id, { deleted: true }); }],
      ['Hide chat from sidebar', () => setAgentHidden(hideKey('chat', undefined, stream.id), true)],
    ]);
  }
  async function selectPiSessions(agentId) {
    const result = await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'list' });
    dialog('Select PI sessions', d => {
      d.append(node('p', 'Add sessions as chats. Closing, archiving or removing a chat never stops PI or deletes its native history.'));
      const search = node('input'); search.type = 'search'; search.placeholder = 'Search sessions'; search.setAttribute('aria-label', 'Search PI sessions');
      const list = node('div'); d.append(search, list);
      const rows = [];
      const filter = () => { const query = search.value.toLocaleLowerCase(); for (const item of rows) item.row.hidden = !item.text().toLocaleLowerCase().includes(query); };
      search.oninput = filter;
      for (const session of result.sessions) {
        const { row, name, preview } = createSessionCard(session, {
          rename: () => {
            formDialog('Rename session', (form, renameDialog) => {
              const editor = field(form, 'Session name', session.name ?? ''); editor.required = true; editor.maxLength = 300;
              form.append(node('p', 'Updates the name in PI. Your messages and session stay unchanged.', 'workspace-context'));
              const error = node('p', '', 'workspace-error'); error.setAttribute('role', 'alert'); form.append(error);
              return async () => {
                const next = editor.value.trim(); if (!next) { error.textContent = 'Enter a session name.'; return; }
                try {
                  await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'rename', sessionId: session.id, name: next });
                  session.name = next; name.textContent = next; row.setAttribute('aria-label', next); filter(); renameDialog.close(); await showAgentStreams(agentId);
                } catch { error.textContent = 'Name could not be confirmed. Check the PI session before retrying.'; }
              };
            });
          },
          open: run(async () => { await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'set', sessionId: session.id, status: 'active' }); d.close(); await showAgentStreams(agentId); await selectRemote(agentId, session.id); }),
        });
        const item = { row, session, previewText: '', text: () => `${session.name} ${session.cwd} ${session.id} ${item.previewText}` }; rows.push(item);
        item.preview = preview; list.append(row);
      }
      let index = 0;
      // Lazy bounded concurrency; names/search remain usable while previews load.
      for (let worker = 0; worker < Math.min(2, rows.length); worker++) void (async () => {
        await Promise.resolve(); // dialog builder runs before showModal().
        while (d.open && index < rows.length) {
          const item = rows[index++];
          try {
            const data = await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'preview', sessionId: item.session.id });
            item.previewText = data.messages.map(message => `${message.role}: ${message.text}`).join('\n');
            item.preview.textContent = item.previewText || 'No text messages yet'; filter();
          } catch { item.preview.textContent = 'Recent messages unavailable'; }
        }
      })();
      search.focus();
    });
  }
  function remoteStreamMenu(stream, event, agentId = browsingAgent, source = peerState) {
    const move = async projectId => {
      await peerRequest(agentId, 'streams', { action: 'move', streamId: stream.id, projectId });
      await showAgentStreams(agentId);
    };
    const agent = agentRoster.find(agent => agent.id === agentId);
    const items = [
      ['Open chat', () => selectRemote(agentId, stream.id)],
      ['Details', async () => conversationDetails(await peerRequest(agentId, 'messages', { action: 'read', streamId: stream.id }), agent?.name ?? 'Remote agent')],
      ['Export conversation…', async () => {
        const conversation = await peerRequest(agentId, 'messages', { action: 'read', streamId: stream.id });
        const text = `# ${conversation.title}\n\n` + conversation.messages.map(message => `## ${message.role}\n\n${message.text}`).join('\n\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const download = node('a'); download.href = url; download.download = `conversation-${stream.id}.md`; download.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }],
      ['Refresh chats', () => showAgentStreams(agentId)],
    ];
    if (source.features?.includes('chat-fork-v1') || agent?.features?.some(feature => ['chat-fork-v1', 'fork-streams'].includes(feature))) items.push(['Fork chat', () => forkChat(stream, agentId)]);
    if (agent?.features?.includes('pi-chat-bindings')) for (const [label, status] of [['Close chat', 'closed'], ['Archive chat', 'archived'], ['Remove chat (keep PI history)', 'deleted']]) items.push([label, async () => {
      await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'set', sessionId: stream.id, status });
      if (remoteSelection?.agentId === agentId && remoteSelection.streamId === stream.id) { clearRemote(); streamId = undefined; }
      await showAgentStreams(agentId);
    }]);
    // PI hosts rename through their native session name (pi-chats), not the generic streams action.
    if (agent?.features?.includes('pi-chat-bindings') && !agent.features.includes('rename-streams')) items.push(['Rename chat', () => formDialog('Rename chat', (form, d) => {
      const name = document.createElement('input'); name.value = stream.title; name.required = true; name.maxLength = 160; name.setAttribute('aria-label', 'Chat name'); form.append(name);
      form.append(node('p', 'Updates the name in PI. Messages and session stay unchanged.', 'workspace-context'));
      return async () => { await peerRequest(agentId, 'messages', { action: 'pi-chats', operation: 'rename', sessionId: stream.id, name: name.value.trim() }); d.close(); await showAgentStreams(agentId); if (remoteSelection?.streamId === stream.id) headingText.textContent = name.value.trim(); };
    })]);
    if (agent?.features?.includes('rename-streams')) items.push(['Rename chat', () => formDialog('Rename chat', (form, d) => {
      const name = document.createElement('input'); name.value = stream.title; name.required = true; name.maxLength = 160; name.setAttribute('aria-label', 'Chat name'); form.append(name);
      return async () => { await peerRequest(agentId, 'streams', { action: 'rename', streamId: stream.id, title: name.value.trim() }); d.close(); await showAgentStreams(agentId); };
    })]);
    if (agent?.features?.includes('organize-streams')) {
      for (const project of source.projects.filter(p => !p.deleted && !p.archived && p.id !== stream.projectId)) items.push([`Move to ${project.title}`, () => move(project.id)]);
      if (stream.projectId && agent.features.includes('standalone-chats')) items.push(['Remove from project', () => move(null)]);
    }
    items.push(['Hide chat from sidebar', () => setAgentHidden(hideKey('chat', agentId, stream.id), true)]);
    popup(event, items);
  }
  function globalMenu(event) {
    const items = [['Global settings', () => settingsDialog('global')], ['Archived / deleted items', () => dialog('Restore items', list => {
      for (const [kind, values] of [['projects', state.projects], ['streams', state.streams]]) for (const value of values.filter(v => v.archived || v.deleted)) list.append(button(`Restore ${value.title}`, async () => { await change(kind, value.id, { archived: false, deleted: false }); list.close(); }));
    })]];
    if (capabilities.credentials === 1) items.push(['Credentials', credentialsDialog]);
    if (capabilities['agent-hub'] === 1) items.push(['Agents', agentsDialog]);
    popup(event, items);
  }
  function credentialsDialog() {
    formDialog('Store a credential', (form, d) => {
      form.append(node('p', 'Write-only: values are never returned to the browser or sent to a chat.'));
      const label = field(form, 'Label'); const value = field(form, 'Secret', '', 'password'); value.autocomplete = 'new-password';
      const list = node('div'); form.append(list);
      run(async () => { const data = await request('/api/workspace/credentials'); for (const entry of data.entries) { const row = node('div'); row.append(node('span', `${entry.label} · ${entry.provider}`), button('Remove', async () => { await request(`/api/workspace/credentials/${entry.id}`, {}, 'DELETE'); row.remove(); })); list.append(row); } })();
      return async () => { await request('/api/workspace/credentials', { label: label.value, value: value.value }); value.value = ''; d.close(); };
    });
  }
  const connectionChecks = new Map();
  async function agentsDialog() {
    clearLocalHistory();
    notice(''); management = true; const revision = ++navigationRevision;
    headingText.textContent = 'Agents'; renderTargets(); body.replaceChildren(node('p', 'Loading registered agents…'));
    const [data, incoming, outbound] = await Promise.all([
      request('/api/workspace/agents'),
      capabilities['agent-link-relay'] === 1 ? request('/api/workspace/agent-relay') : null,
      capabilities['agent-link-outbound'] === 1 ? request('/api/workspace/agent-outbound') : null,
    ]);
    if (!management || revision !== navigationRevision) return;
    const content = node('section', undefined, 'agent-management');
    content.append(node('h2', 'Registered agents'), node('p', 'Register an agent before adding it to projects. Registration establishes a connection; it does not share project files or credentials.'));
    const direct = { ...data, adapters: data.adapters.filter(adapter => adapter !== 'hayate-wss') };
    if (direct.adapters.length) content.append(button('Register an agent', () => registrationForm(direct)));
    if (incoming && data.adapters.includes('hayate-wss')) content.append(button('Invite outbound agent', () => outboundInvitation(revision)), button('Refresh incoming connections', agentsDialog));
    if (outbound) {
      const local = node('article', undefined, 'agent-card'); local.setAttribute('aria-label', 'This agent outbound connection');
      local.append(node('h3', 'This agent → central dashboard'), node('p', outbound.endpoint ?? 'No outbound connection configured'), node('p', outbound.revoked ? 'Authorization revoked' : outbound.connected ? 'WSS connected; central approval is required for work' : 'Disconnected'));
      if (!outbound.id) local.append(button('Connect this agent outbound', () => outboundEnrollment(revision)));
      else local.append(button('Disconnect outbound link', async () => { if (!confirm('Revoke this outbound connection? Accepted work is not cancelled.')) return; await request('/api/workspace/agent-outbound', { action: 'disconnect' }); if (management) await agentsDialog(); }));
      content.append(local);
    }
    for (const pending of incoming?.agents.filter(agent => !agent.approved && !agent.revoked) ?? []) {
      const card = node('article', undefined, 'agent-card'); card.setAttribute('aria-label', `Incoming agent ${pending.name}`);
      card.append(node('h3', pending.name), node('p', `Target identity: ${pending.remoteAgent}`), node('p', `Permissions: ${pending.capabilities.join(', ')}`), node('p', pending.connected ? 'Connected · awaiting your approval' : 'Disconnected · not registered'));
      card.append(button('Approve and register', async event => { event.target.disabled = true; try { await request(`/api/workspace/agent-relay/${pending.id}/accept`, {}); await refreshAgents(); if (management) await agentsDialog(); } finally { event.target.disabled = false; } }),
        button('Reject connection', async event => { event.target.disabled = true; try { await request(`/api/workspace/agent-relay/${pending.id}/reject`, {}); if (management) await agentsDialog(); } finally { event.target.disabled = false; } }));
      content.append(card);
    }
    if (!data.adapters.length) content.append(node('p', 'Install and configure an agent transport adapter on this instance before registering an agent.'));
    if (!data.agents.length) content.append(node('p', 'No remote agents registered yet.'));
    for (const agent of data.agents) {
      const card = node('article', undefined, 'agent-card'); card.setAttribute('aria-label', `Registered agent ${agent.name}`);
      const title = node('h3', agent.name); if (/^#[a-f0-9]{6}$/i.test(agent.color ?? '')) title.style.borderLeft = `4px solid ${agent.color}`;
      const check = connectionChecks.get(agent.id) ?? agent.connection;
      card.append(title, node('p', agent.endpoint), node('p', `Identity: ${agent.remoteAgent} · Transport: ${agent.adapter}`),
        node('p', `Permissions: ${agent.capabilities.join(', ') || 'None'}`),
        node('p', agent.authorizationRevoked ? 'Target access revoked · local cleanup pending' : check ? `${check.status}${check.checkedAt ? ' · checked ' + new Date(check.checkedAt).toLocaleString() : ''}` : 'Not checked yet'));
      const actions = node('div', undefined, 'agent-actions');
      if (agent.capabilities.includes('streams')) actions.append(button('Open chats', () => { agentPicker.value = agent.id; return agentPicker.onchange(); }));
      actions.append(button('Check connection', async event => {
        const trigger = event.target; trigger.disabled = true;
        try {
          let result;
          if (data.features?.includes('connection-check')) result = await request(`/api/workspace/agents/${agent.id}/check`, {});
          else {
            const capability = ['activity', 'streams', 'projects'].find(value => agent.capabilities.includes(value));
            result = { status: 'unsupported', checkedAt: Date.now() };
            if (capability) { try { await peerRequest(agent.id, capability, { action: 'list' }); result.status = 'connected'; } catch { result.status = 'unavailable'; } }
          }
          connectionChecks.set(agent.id, result); if (management && navigationRevision === revision) await agentsDialog();
        } finally { trigger.disabled = false; }
      }));
      if (data.features?.includes('agent-presentation')) actions.append(button('Edit name and color', () => formDialog('Agent settings', (form, d) => {
        const name = field(form, 'Agent name', agent.name); name.required = true; name.maxLength = 160;
        const selectedColor = field(form, 'Optional color (#rrggbb)', agent.color ?? ''); selectedColor.pattern = '#[a-fA-F0-9]{6}';
        return async () => { await request(`/api/workspace/agents/${agent.id}`, { name: name.value, color: selectedColor.value || null }); d.close(); await refreshAgents(); if (management) await agentsDialog(); };
      })));
      actions.append(button('Remove agent', async event => {
        if (!confirm(`Remove ${agent.name}? Target authorization must be revoked before the registration is removed. This does not stop its running work or delete its history.`)) return;
        const trigger = event.target; trigger.disabled = true;
        try {
          await request(`/api/workspace/agents/${agent.id}`, {}, 'DELETE');
          agentSnapshots.delete(agent.id); connectionChecks.delete(agent.id);
          if (browsingAgent === agent.id) { browsingAgent = undefined; peerState = undefined; clearRemote(); }
          await refreshAgents(); if (management) await agentsDialog();
        } catch { notice('Removal was not confirmed. The registration is retained; restore connectivity and retry.'); }
        finally { trigger.disabled = false; }
      }));
      card.append(actions); content.append(card);
    }
    body.replaceChildren(content);
  }
  function outboundInvitation(revision) {
    formDialog('Invite outbound agent', (form, d) => {
      form.append(node('p', 'The agent connects outward over HTTPS/WSS. No inbound agent port is required. You must approve the incoming connection separately.'));
      const name = field(form, 'Agent name'); name.required = true; name.maxLength = 160;
      return async () => {
        const invite = await request('/api/workspace/agent-relay', { name: name.value }); d.close();
        if (!management || navigationRevision !== revision) return;
        headingText.textContent = 'Outbound invitation';
        const section = node('section', undefined, 'agent-management');
        const code = node('input'); code.type = 'password'; code.readOnly = true; code.value = invite.code; code.autocomplete = 'off'; code.setAttribute('aria-label', 'Outbound invitation code');
        section.append(node('h2', 'Connect the target agent'), node('p', invite.endpoint), node('p', `Single use · expires ${new Date(invite.expiresAt).toLocaleTimeString()}`), code,
          button('Show code', event => { code.type = code.type === 'password' ? 'text' : 'password'; event.target.textContent = code.type === 'text' ? 'Hide code' : 'Show code'; }),
          button('Copy code', () => navigator.clipboard.writeText(code.value)),
          node('p', 'On the target, open Agents → Connect this agent outbound, or use /agent-link-outbound enroll <HTTPS endpoint> <invitation code> as administrator. The outbound plugin must be enabled first.'),
          button('Back to incoming connections', agentsDialog));
        body.replaceChildren(section);
      };
    });
  }
  function outboundEnrollment(revision) {
    formDialog('Connect this agent outbound', (form, d) => {
      const endpoint = field(form, 'Central HTTPS endpoint', '', 'url'); endpoint.required = true;
      const code = field(form, 'Outbound invitation code', '', 'password'); code.required = true; code.autocomplete = 'one-time-code';
      form.append(node('p', 'Get a single-use invitation from the central dashboard. TLS and local relay policy must allow the endpoint. The central operator approves the connection after enrollment.'));
      return async () => {
        const input = { endpoint: endpoint.value, code: code.value.trim() }; code.value = '';
        await request('/api/workspace/agent-outbound', input); d.close();
        if (management && navigationRevision === revision) await agentsDialog();
      };
    });
  }
  function registrationForm(data) {
    management = true; const revision = ++navigationRevision; headingText.textContent = 'Register an agent'; renderTargets();
    const section = node('section', undefined, 'agent-management');
    section.append(node('h2', 'Connect a Hayate agent'), node('p', 'On the target agent, run /agent-hub pair. It returns the HTTPS endpoint and a single-use code valid for five minutes. The target must have its AgentLink endpoint enabled.'), node('p', 'Use the target’s registration code, never its browser password or an API token.'));
    const form = node('form', undefined, 'agent-registration');
    const name = field(form, 'Agent name'); name.required = true; name.maxLength = 160;
    const endpoint = field(form, 'HTTPS endpoint', '', 'url'); endpoint.required = true; endpoint.placeholder = 'https://agent.example.org';
    const code = field(form, 'Registration code', '', 'password'); code.required = true; code.autocomplete = 'one-time-code'; code.spellcheck = false;
    const selectedColor = field(form, 'Optional color (#rrggbb)'); selectedColor.pattern = '#[a-fA-F0-9]{6}';
    const adapter = node('select'); adapter.setAttribute('aria-label', 'Transport adapter');
    for (const value of data.adapters) { const option = node('option', value); option.value = value; adapter.append(option); }
    if (data.adapters.length > 1) form.append(adapter);
    const error = node('p', '', 'workspace-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const submit = node('button', 'Connect agent'); submit.type = 'submit';
    form.append(error, submit, button('Back to agents', agentsDialog)); section.append(form); body.replaceChildren(section);
    form.onsubmit = event => { event.preventDefault(); if (submit.disabled) return;
      run(async () => {
        error.hidden = true;
        const url = new URL(endpoint.value);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) { error.textContent = 'Use a canonical HTTPS endpoint without credentials, path, query or fragment.'; error.hidden = false; return; }
        if (data.agents.some(agent => agent.adapter === adapter.value && new URL(agent.endpoint).href === url.href)) { error.textContent = 'This endpoint is already registered. Manage the existing registration instead.'; error.hidden = false; return; }
        const payload = { name: name.value, endpoint: url.origin, code: code.value.trim(), adapter: adapter.value, ...(selectedColor.value ? { color: selectedColor.value } : {}) };
        code.value = ''; submit.disabled = true;
        try { await request('/api/workspace/agents', payload); await refreshAgents(); if (management && navigationRevision === revision) await agentsDialog(); }
        catch { error.textContent = 'Registration was not confirmed. Check the agent list before trying again; obtain a fresh code on the target if needed. HTTPS certificate validation and target access policy must succeed.'; error.hidden = false; }
        finally { submit.disabled = false; }
      })();
    };
    name.focus();
  }
  function remoteStreams(agent) {
    dialog(agent.name, d => {
      const content = node('div'); d.append(content);
      const remote = (capability, input) => request(`/api/workspace/agents/${agent.id}/request`, { capability, input });
      run(async () => {
        const { streams } = await remote('streams', { action: 'list' });
        for (const stream of streams) content.append(button(`${stream.unread ? '● ' : ''}${stream.title}`, async () => {
          const conversation = await remote('messages', { action: 'read', streamId: stream.id });
          content.replaceChildren(node('p', `${agent.name} · ${stream.title}`));
          for (const message of conversation.messages) { const entry = node('article', undefined, `message ${message.role}`); entry.append(message.role === 'assistant' ? markdown(message.text) : node('p', message.text)); content.append(entry); }
          const form = node('form'), text = node('textarea'), submit = node('button', 'Send to agent'); submit.type = 'submit'; text.setAttribute('aria-label', 'Message to remote agent'); form.append(text, submit); content.append(form);
          const key = `workspace.remote.${agent.id}.${stream.id}`;
          let attempt;
          try { attempt = JSON.parse(sessionStorage.getItem(key)); if (attempt) text.value = attempt.text; } catch { /* Browser drafts are not authority. */ }
          form.onsubmit = event => { event.preventDefault(); run(async () => {
            if (!text.value.trim()) return;
            if (attempt && attempt.text !== text.value.trim()) throw Error('An earlier send is unconfirmed. Reconcile it before changing the message.');
            attempt ??= { action: 'send', streamId: stream.id, id: crypto.randomUUID(), text: text.value.trim() };
            sessionStorage.setItem(key, JSON.stringify(attempt)); submit.disabled = true;
            try { await remote('messages', attempt); text.value = ''; attempt = undefined; sessionStorage.removeItem(key); content.append(node('p', 'Accepted by target. Reopen the stream to refresh its reply.')); }
            finally { submit.disabled = false; }
          })(); };
        }));
        if (!streams.length) content.append(node('p', 'No shared streams. Create one on the target agent.'));
      })();
    });
  }
  let attempts = new Map();
  try { attempts = new Map(JSON.parse(sessionStorage.getItem('workspace.pending') ?? '[]')); } catch { /* Corrupt browser preferences do not alter domain state. */ }
  composer.onsubmit = event => { event.preventDefault(); if (sending || remoteSelection?.stale) return; sending = true; send.disabled = true; run(async () => {
    try {
    if (!input.value.trim() && !mediaDrafts.list(activeDraftKey).length) return;
    if (mediaDrafts.list(activeDraftKey).length && !supportsImages()) throw Error('This conversation does not support images; files retained, nothing sent');
    const submittedDraft = activeDraftKey, submittedMode = piMode.value;
    let submittedImages = [...mediaDrafts.list(submittedDraft)];
    let imageDraftIdentity = submittedImages.map(item => item.id).join(':');
    if (capabilities['local-agent'] === false && !browsingAgent && !remoteSelection) throw Error('Choose a registered agent before sending');
    let id = streamId || '';
    if (browsingAgent && !remoteSelection) id = `remote-new:${browsingAgent}`;
    if (remoteSelection || id.startsWith('remote-new:')) {
      const text = input.value.trim(); const submittedProject = projectId, submittedNavigation = navigationRevision;
      let agentId = remoteSelection?.agentId ?? id.split(':')[1];
      let remoteId = remoteSelection?.streamId ?? (id.startsWith('remote:') ? id.split(':')[2] : null);
      const key = `remote:${projectId}:${agentId}:${remoteId ?? 'new'}`;
      let attempt = attempts.get(key);
      if (attempt && remoteId) {
        let status;
        try { status = await peerRequest(agentId, 'messages', { action: 'submission-status', streamId: remoteId, id: attempt.id }); } catch { /* Older peers or unknown outcomes require explicit review. */ }
        if (status?.status === 'accepted') {
          attempts.delete(key); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
          const acceptedImages = new Set((attempt.imageDraftIdentity ?? '').split(':').filter(Boolean));
          for (const item of mediaDrafts.list(submittedDraft)) if (acceptedImages.has(item.id)) mediaDrafts.remove(submittedDraft, item.id);
          renderAttachments();
          if (attempt.text === text) { clearSentDraft(submittedDraft, text); notice('The earlier message was accepted. It was not resent. New image drafts were kept.'); return; }
          submittedImages = submittedImages.filter(item => !acceptedImages.has(item.id));
          imageDraftIdentity = submittedImages.map(item => item.id).join(':');
          attempt = undefined;
        }
      }
      if (attempt && (attempt.imageDraftIdentity ?? '') !== imageDraftIdentity) throw Error('Image selection changed while an earlier send is unresolved. Reconcile that send before sending different attachments.');
      attempt ??= { id: crypto.randomUUID(), creationKey: crypto.randomUUID(), text };
      if (attempt.text !== text) {
        // Explicit operator policy: a different draft discards the old attempt,
        // never replays it. The new draft gets its own submission identity.
        attempts.delete(key);
        attempt = { id: crypto.randomUUID(), creationKey: crypto.randomUUID(), text };
        sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
      }
      attempts.set(key, attempt); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = true;
      try {
        if (!remoteId) {
          const agent = agentRoster.find(agent => agent.id === agentId);
          if (!agent?.features?.includes('idempotent-stream-create')) throw Error('Target does not support safe stream creation');
          const destination = projectId ?? (peerState?.projects?.length === 1 ? peerState.projects[0].id : null);
          if (!destination && !agent.features.includes('standalone-chats')) throw Error('Choose a shared project; this agent has not enabled standalone chats.');
          if (agent.features.includes('pi-live-v1') && !attempt.cwd) {
            const info = await peerRequest(agentId, 'messages', { action: 'pi', route: '/api/pi/sessions' });
            const cwd = window.prompt('PI working directory (inside allowed roots)', info.roots?.[0] ?? '');
            if (!cwd) return;
            attempt.cwd = cwd;
            sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
          }
          const stream = await peerRequest(agentId, 'streams', { action: 'create', projectId: destination, title: text.slice(0, 72), idempotencyKey: attempt.creationKey, ...(attempt.cwd ? { cwd: attempt.cwd } : {}) }); remoteId = stream.id;
        }
        const previousIds = remoteSelection?.agentId === agentId && remoteSelection.streamId === remoteId ? (remoteSelection.history ?? []).map(message => message.id) : [];
        const receiptKey = JSON.stringify(['remote', agentId, remoteId]);
        const receipts = acceptedMessages.get(receiptKey) ?? [];
        let receipt = receipts.find(item => item.id === attempt.id);
        if (!receipt && text.trim() !== '/reload') {
          receipt = { id: attempt.id, text, mode: submittedMode, previousIds, unconfirmed: true };
          receipts.push(receipt);
        }
        acceptedMessages.set(receiptKey, receipts);
        // Render uncertainty before waiting for transport acknowledgement. A
        // failed response does not prove the native owner rejected this input.
        if (remoteSelection?.agentId === agentId && remoteSelection.streamId === remoteId) {
          remoteSelection.signature = undefined;
          void showRemote(remoteSelection, true).catch(() => {});
        }
        if (submittedImages.length && !attempt.attachments) {
          attempt.imageDraftIdentity = imageDraftIdentity;
          const uploaded = [];
          for (const item of submittedImages) uploaded.push(await uploadImageChunks(item.file, chunk => peerRequest(agentId, 'messages', { action: 'media-chunk', streamId: remoteId, chunk })));
          attempt.attachments = uploaded;
        }
        const delivery = await peerRequest(agentId, 'messages', { action: 'send', streamId: remoteId, id: attempt.id, text, ...(attempt.attachments?.length ? { attachments: attempt.attachments } : {}), ...(agentRoster.find(agent => agent.id === agentId)?.features?.includes('pi-live-v1') && submittedMode ? { mode: submittedMode } : {}) });
        if (delivery?.operation === 'reload') notice('Reload angenommen. Abschluss erst nach Wiederverbindung des nativen PI bestätigt.');
        else if (receipt) receipt.unconfirmed = false;
        attempts.delete(key);
        clearSentDraft(submittedDraft, text);
        for (const item of submittedImages) mediaDrafts.remove(submittedDraft, item.id); renderAttachments();
        if (projectId === submittedProject && navigationRevision === submittedNavigation) {
          if (input.value.trim() === text) input.value = '';
          const snapshot = await peerRequest(agentId, 'streams', { action: 'list' });
          if (navigationRevision === submittedNavigation) { peerState = { ...peerState, ...snapshot }; agentSnapshots.set(agentId, peerState); await selectRemote(agentId, remoteId); }
        }
      } finally { sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = false; }
      return;
    }
    const text = input.value.trim(), submittedProject = projectId, submittedNavigation = navigationRevision;
    if (!id) {
      const key = `create:local:${projectId ?? 'standalone'}`;
      const creation = attempts.get(key) ?? { creationKey: crypto.randomUUID(), text };
      if (creation.text !== text) throw Error('Retry the previous unconfirmed input before sending different work');
      attempts.set(key, creation); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
      const stream = await request('/api/workspace/streams', { projectId: projectId ?? null, title: text.slice(0, 72), idempotencyKey: creation.creationKey });
      id = stream.id;
      // The new stream's first attempt carries the same image selection; otherwise
      // a first send with images would be rejected as a changed draft.
      if (!attempts.has(id)) attempts.set(id, { id: crypto.randomUUID(), text, imageDraftIdentity });
      attempts.delete(key); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
      if (navigationRevision === submittedNavigation) { streamId = id; await refresh(); }
    }
    const attempt = attempts.get(id) ?? { id: crypto.randomUUID(), text, imageDraftIdentity };
    if ((attempt.imageDraftIdentity ?? '') !== imageDraftIdentity) throw Error('Image selection changed while an earlier send is unresolved; reconcile it first');
    if (attempt.text !== text) throw Error('Retry the previous unconfirmed input before sending different work');
    attempts.set(id, attempt); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = true;
    if (mediaDrafts.list(submittedDraft).length && !attempt.attachments) {
      const uploaded = [];
      for (const item of submittedImages) uploaded.push(await uploadImageChunks(item.file, chunk => request(`/api/workspace/streams/${id}/media`, chunk)));
      attempt.attachments = uploaded;
    }
    try { await request(`/api/workspace/streams/${id}/messages`, attempt); attempts.delete(id); clearSentDraft(submittedDraft, text); for (const item of submittedImages) mediaDrafts.remove(submittedDraft, item.id); renderAttachments();
      if (projectId === submittedProject && navigationRevision === submittedNavigation) { if (input.value.trim() === text) input.value = ''; await refresh(); await selectStream(id); }
    }
    finally { sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = false; }
    } finally { sending = false; renderTargets(); }
  })(); };
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
  window.addEventListener('beforeunload', () => events?.close());
  await refresh(); await showWorkspace(true); await refreshAgents();
  await run(() => navigation.restore())();
  return true;
}
