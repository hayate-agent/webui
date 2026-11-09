// Optional frontend projection. No project/agent/secret domain state is stored here.
export async function mountWorkspace({ request, notice, markdown }) {
  const capabilities = await request('/api/workspace/capabilities');
  if (capabilities.workspaces !== 1) return;
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const run = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(e => notice(e.message));
  const button = (text, fn) => { const e = node('button', text); e.type = 'button'; e.title = text; e.onclick = run(fn); return e; };
  let state, projectId, streamId, events, visible = false;
  let remoteSelection, remoteRefreshing = false, browsingAgent;
  let agentRoster = [], navigationRevision = 0, peerState, sending = false, management = false;
  const newest = (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) || a.id.localeCompare(b.id);
  const remoteProjects = new Map(), agentSnapshots = new Map();
  const peerRequest = (agentId, capability, input) => request(`/api/workspace/agents/${agentId}/request`, { capability, input });
  const panel = node('section', undefined, 'workspace-screen'); panel.hidden = true;
  const heading = node('header'); const headingText = node('h1', 'New chat');
  const menu = button('⋮', event => globalMenu(event)); menu.setAttribute('aria-label', 'Workspace settings');
  const agentLabel = node('label', 'Agent'); agentLabel.className = 'agent-picker';
  const agentPicker = node('select'); agentPicker.setAttribute('aria-label', 'Active agent'); agentLabel.append(agentPicker);
  const projectLabel = node('label', 'Project (optional)'); projectLabel.className = 'agent-picker';
  const projectPicker = node('select'); projectPicker.setAttribute('aria-label', 'Chat project'); projectLabel.append(projectPicker);
  const chatContext = node('p', '', 'workspace-context'); chatContext.hidden = true;
  heading.append(headingText, agentLabel, projectLabel, chatContext, menu);
  projectPicker.onchange = run(() => selectProject(projectPicker.value || undefined));
  const errorBox = node('p', '', 'workspace-error'); errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
  const legacyNotice = notice; notice = message => { legacyNotice(message); errorBox.textContent = message ?? ''; errorBox.hidden = !message; };
  const body = node('section', undefined, 'workspace-content');
  const composer = node('form', undefined, 'workspace-composer');
  const input = node('textarea'); input.rows = 3; input.placeholder = 'What would you like to do today?'; input.setAttribute('aria-label', 'Next project step');
  const send = node('button', 'Send ↑'); send.type = 'submit'; send.setAttribute('aria-label', 'Send ↑');
  composer.append(input, send); panel.append(heading, errorBox, body, composer);
  const legacyMain = document.querySelector('main'); legacyMain.after(panel);
  const tree = node('nav', undefined, 'workspace-tree'); tree.hidden = true; tree.setAttribute('aria-label', 'Projects and streams'); $('chats').after(tree);
  async function showWorkspace(value) {
    visible = value; legacyMain.hidden = visible; panel.hidden = !visible; tree.hidden = !visible; $('chats').hidden = visible;
    if (visible) { await refresh(); beginEvents(); }
    else { events?.close(); agentPicker.value = 'local'; }
  }
  $('new').textContent = '＋ New chat';
  $('new').onclick = run(async () => { management = false; navigationRevision++; streamId = undefined; remoteSelection = undefined; projectId = undefined; browsingAgent = undefined; peerState = undefined; renderTree(); renderTargets(); renderDashboard(); beginEvents(); input.focus(); });
  $('search').oninput = () => renderTree();
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
          const [snapshot, projects] = await Promise.all([peerRequest(agent.id, 'streams', { action: 'list' }), peerRequest(agent.id, 'projects', { action: 'list' })]);
          agent.features = snapshot.features ?? [];
          agentSnapshots.set(agent.id, { ...snapshot, projects: projects.projects ?? [] });
        } catch { agentSnapshots.set(agent.id, { projects: [], streams: [], unavailable: true }); }
      }
    }));
    renderTree();
  }
  agentPicker.onchange = run(async () => {
    management = false; navigationRevision++;
    const id = agentPicker.value;
    peerState = undefined; projectId = undefined; streamId = undefined;
    if (id === 'local') { browsingAgent = undefined; remoteSelection = undefined; render(); beginEvents(); return; }
    browsingAgent = id; remoteSelection = undefined; streamId = undefined; projectId = undefined;
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
    events = new EventSource(`/api/workspace/events${streamId ? `?stream=${encodeURIComponent(streamId)}` : ''}`);
    events.onmessage = event => {
      const next = JSON.parse(event.data); state = next;
      renderTree(); if (management) return; renderTargets();
      if (remoteSelection || browsingAgent) return;
      if (streamId && next.conversation?.id === streamId) renderConversation(next.conversation);
      else if (!streamId) renderDashboard();
    };
    events.onerror = () => { if (visible) notice('Workspace connection interrupted; reconnecting without resubmitting work.'); };
  }
  function renderTree() {
    const fragment = document.createDocumentFragment();
    if (capabilities['project-creation'] !== false) fragment.append(button('＋ New project', () => projectDialog()));
    if (capabilities['agent-hub'] === 1) fragment.append(button('Agents', agentsDialog));
    if (capabilities['local-agent'] !== false) fragment.append(renderAgentTree(state, undefined, state.agent));
    for (const agent of agentRoster) fragment.append(renderAgentTree(agentSnapshots.get(agent.id) ?? { projects: [], streams: [] }, agent.id, agent.name));
    tree.replaceChildren(fragment);
  }
  function renderAgentTree(source, agentId, name) {
    const fragment = node('section', undefined, 'workspace-agent-group'); fragment.dataset.agentId = agentId ?? 'local';
    const choose = () => { agentPicker.value = agentId ?? 'local'; agentPicker.onchange(); };
    const label = button(name, choose); label.className = 'workspace-agent-heading'; fragment.append(label);
    if (source.unavailable) fragment.append(node('p', 'Unavailable', 'workspace-context'));
    const projects = source.projects.filter(p => !p.deleted && !p.archived && !(p.importSource === 'webui' && p.title === 'Existing chats' && !p.parentId && !Object.keys(p.settings ?? {}).length && !source.projects.some(child => child.parentId === p.id)));
    const query = $('search').value.toLocaleLowerCase();
    const streams = source.streams.filter(s => !s.deleted && !s.archived && !source.projects.some(p => p.id === s.projectId && (p.deleted || p.archived)));
    const matches = stream => stream.title.toLocaleLowerCase().includes(query);
    function row(stream) {
      const element = node('div', undefined, 'workspace-stream-row'); element.dataset.streamId = stream.id;
      const select = button(`${stream.unread ? '● ' : ''}${stream.title}`, () => agentId ? selectRemote(agentId, stream.id) : selectStream(stream.id));
      select.setAttribute('aria-current', String(stream.id === (remoteSelection?.streamId ?? streamId)));
      const more = button('⋮', event => agentId ? remoteStreamMenu(stream, event, agentId, source) : streamMenu(stream, event)); more.setAttribute('aria-label', `Settings for ${stream.title}`);
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
    composer.hidden = management;
    if (management) { agentLabel.hidden = true; projectLabel.hidden = true; chatContext.hidden = true; return; }
    send.disabled = sending || capabilities['local-agent'] === false && !browsingAgent && !remoteSelection;
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
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
    const fragment = document.createDocumentFragment();
    for (const message of stream.messages) {
      const row = node('article', undefined, `message ${message.role}`);
      row.append(message.role === 'assistant' ? markdown(message.text) : node('div', message.text));
      if (message.accepted === false) row.append(node('small', 'Acceptance unconfirmed'), button('Retry safely', async () => {
        await request(`/api/workspace/streams/${stream.id}/messages`, { id: message.id, text: message.text });
        attempts.delete(stream.id); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
      }));
      fragment.append(row);
    }
    if (stream.activity) {
      if (stream.activity.text) { const preview = node('article', undefined, 'message assistant'); preview.append(markdown(stream.activity.text)); fragment.append(preview); }
      fragment.append(node('p', Object.entries(stream.activity.tools).filter(([, n]) => n).map(([name, n]) => `${name} ×${n}`).join(' · ') || 'Waiting for agent output…', 'workspace-context'));
    }
    body.replaceChildren(fragment);
    if (nearBottom) body.scrollTop = body.scrollHeight;
    if (stream.unread) run(() => change('streams', stream.id, { read: true }))();
  }
  async function refreshRemote() {
    if (!visible || management || capabilities['agent-hub'] !== 1 || remoteRefreshing) return;
    if (browsingAgent) {
      remoteRefreshing = true;
      try {
        const id = browsingAgent, revision = navigationRevision;
        const snapshot = await peerRequest(id, 'streams', { action: 'list' });
        if (id !== browsingAgent || revision !== navigationRevision) return;
        peerState = { ...peerState, ...snapshot }; agentSnapshots.set(id, peerState); renderTree();
        if (remoteSelection) await showRemote(remoteSelection);
      } catch { notice('Target unavailable; retained conversation may be stale. No work was resubmitted.'); } finally { remoteRefreshing = false; }
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
        if (agent?.status === 'connected') await showRemote(selectedRemote);
        else notice('Target unavailable; retained conversation is stale. No work was resubmitted.');
      } else if (!streamId && !remoteSelection) renderDashboard();
    } catch { if (projectId === selected) notice('Agent refresh failed; retained remote state may be stale.'); }
    finally { remoteRefreshing = false; }
  }
  async function showRemote(selection) {
    const revision = selection.revision = (selection.revision ?? 0) + 1;
    const conversation = await peerRequest(selection.agentId, 'messages', { action: 'read', streamId: selection.streamId });
    if (remoteSelection !== selection || selection.revision !== revision) return;
    const agent = remoteProjects.get(projectId)?.agents.find(agent => agent.agentId === selection.agentId) ?? agentRoster.find(agent => agent.id === selection.agentId);
    headingText.textContent = conversation.title;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
    const signature = JSON.stringify(conversation);
    if (selection.signature !== signature) {
      selection.signature = signature;
      const fragment = document.createDocumentFragment();
      for (const message of conversation.messages) { const row = node('article', undefined, `message ${message.role}`); row.append(message.role === 'assistant' ? markdown(message.text) : node('p', message.text)); fragment.append(row); }
      if (conversation.activity?.text) { const row = node('article', undefined, 'message assistant'); row.append(markdown(conversation.activity.text)); fragment.append(row); }
      if (conversation.activity) fragment.append(node('p', Object.entries(conversation.activity.tools ?? {}).filter(([, count]) => count).map(([name, count]) => `${name} ×${count}`).join(' · ') || 'Target is working…', 'workspace-context'));
      body.replaceChildren(fragment); if (nearBottom) body.scrollTop = body.scrollHeight;
    }
    if (conversation.unread && agent?.features?.includes('read-markers')) await peerRequest(selection.agentId, 'messages', { action: 'mark-read', streamId: selection.streamId });
  }
  async function selectRemote(agentId, id) {
    management = false; navigationRevision++;
    peerState = agentSnapshots.get(agentId);
    projectId = peerState?.streams?.find(s => s.id === id)?.projectId;
    streamId = undefined; browsingAgent = agentId; remoteSelection = { agentId, streamId: id }; renderTree(); renderTargets();
    await showRemote(remoteSelection); input.focus();
  }
  setInterval(() => { if (!document.hidden) void refreshRemote(); }, 5000);
  function render() {
    renderTree(); if (management) return; renderTargets();
    if (remoteSelection) run(() => showRemote(remoteSelection))();
    else if (browsingAgent) run(() => showAgentStreams(browsingAgent))();
    else if (streamId) {
      const id = streamId, revision = navigationRevision;
      run(async () => { const conversation = await request(`/api/workspace/streams/${id}`); if (navigationRevision === revision && streamId === id && !browsingAgent) renderConversation(conversation); })();
    } else renderDashboard();
  }
  async function selectProject(id) { management = false; navigationRevision++; projectId = id; streamId = undefined; remoteSelection = undefined; renderTree(); renderTargets(); renderDashboard(); beginEvents(); input.focus(); if (!browsingAgent) void refreshRemote(); }
  async function selectStream(id) {
    management = false; navigationRevision++;
    const stream = state.streams.find(s => s.id === id); if (!stream) return;
    projectId = stream.projectId; streamId = id; remoteSelection = undefined; browsingAgent = undefined; peerState = undefined; render(); beginEvents(); input.focus();
  }
  function popup(event, items) {
    document.querySelector('.workspace-menu')?.remove();
    const anchor = event?.target?.closest('button') ?? event?.target;
    const rect = anchor?.getBoundingClientRect() ?? { left: 16, right: 16, bottom: 40 };
    const menu = node('div', undefined, 'workspace-menu'); menu.popover = 'auto'; menu.setAttribute('role', 'menu');
    for (const [label, action] of items) {
      const item = button(label, () => { menu.hidePopover(); menu.remove(); return action(); });
      item.setAttribute('role', 'menuitem'); item.tabIndex = -1;
      if (label.startsWith('Delete')) item.classList.add('danger');
      menu.append(item);
    }
    document.body.append(menu); menu.showPopover();
    const x = event?.type === 'contextmenu' ? event.clientX : rect.left;
    const y = event?.type === 'contextmenu' ? event.clientY : rect.bottom + 5;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    const entries = [...menu.querySelectorAll('button')]; entries[0]?.focus();
    menu.onkeydown = key => {
      const index = entries.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key)) {
        key.preventDefault(); entries[key.key === 'Home' ? 0 : key.key === 'End' ? entries.length - 1 : (index + (key.key === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length]?.focus();
      }
      if (key.key === 'Escape') { key.preventDefault(); menu.hidePopover(); menu.remove(); anchor?.focus(); }
    };
    menu.ontoggle = () => { if (!menu.matches(':popover-open')) menu.remove(); };
  }
  function dialog(title, build) {
    const d = node('dialog', undefined, 'workspace-dialog'); d.append(node('h2', title));
    d.append(button('Close', () => d.close())); build(d); document.body.append(d);
    d.onclose = () => d.remove(); d.showModal(); return d;
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
    popup(event, items);
  }
  function streamMenu(stream, event) {
    popup(event, [
      ['Settings', () => settingsDialog('stream', stream)],
      ['Details', () => conversationDetails(stream, state.agent)],
      ['Move to project…', () => popup(event, state.projects.filter(p => !p.deleted && !p.archived && p.importSource !== 'webui').map(p => [p.title, () => change('streams', stream.id, { projectId: p.id })]))],
      ['Remove from project', () => change('streams', stream.id, { projectId: null })],
      ['Convert to project', async () => { const p = await request(`/api/workspace/streams/${stream.id}/convert`, {}); await refresh(); await selectProject(p.id); }],
      ['Archive', () => change('streams', stream.id, { archived: true })],
      ['Delete (recoverable)', async () => { if (confirm('Hide this chat without deleting history or cancelling work?')) await change('streams', stream.id, { deleted: true }); }],
    ]);
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
    if (agent?.features?.includes('organize-streams')) {
      for (const project of source.projects.filter(p => !p.deleted && !p.archived && p.id !== stream.projectId)) items.push([`Move to ${project.title}`, () => move(project.id)]);
      if (stream.projectId && agent.features.includes('standalone-chats')) items.push(['Remove from project', () => move(null)]);
    }
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
          if (browsingAgent === agent.id) { browsingAgent = undefined; peerState = undefined; remoteSelection = undefined; }
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
  composer.onsubmit = event => { event.preventDefault(); if (sending) return; sending = true; send.disabled = true; run(async () => {
    try {
    if (!input.value.trim()) return;
    if (capabilities['local-agent'] === false && !browsingAgent && !remoteSelection) throw Error('Choose a registered agent before sending');
    let id = streamId || '';
    if (browsingAgent && !remoteSelection) id = `remote-new:${browsingAgent}`;
    if (remoteSelection || id.startsWith('remote-new:')) {
      const text = input.value.trim(); const submittedProject = projectId, submittedNavigation = navigationRevision;
      let agentId = remoteSelection?.agentId ?? id.split(':')[1];
      let remoteId = remoteSelection?.streamId ?? (id.startsWith('remote:') ? id.split(':')[2] : null);
      const key = `remote:${projectId}:${agentId}:${remoteId ?? 'new'}`;
      const attempt = attempts.get(key) ?? { id: crypto.randomUUID(), creationKey: crypto.randomUUID(), text };
      if (attempt.text !== text) throw Error('Reconcile the earlier unconfirmed remote input before sending different work');
      attempts.set(key, attempt); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = true;
      try {
        if (!remoteId) {
          const agent = agentRoster.find(agent => agent.id === agentId);
          if (!agent?.features?.includes('idempotent-stream-create')) throw Error('Target does not support safe stream creation');
          const destination = projectId ?? (peerState?.projects?.length === 1 ? peerState.projects[0].id : null);
          if (!destination && !agent.features.includes('standalone-chats')) throw Error('Choose a shared project; this agent has not enabled standalone chats.');
          const stream = await peerRequest(agentId, 'streams', { action: 'create', projectId: destination, title: text.slice(0, 72), idempotencyKey: attempt.creationKey }); remoteId = stream.id;
        }
        await peerRequest(agentId, 'messages', { action: 'send', streamId: remoteId, id: attempt.id, text });
        attempts.delete(key);
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
      if (!attempts.has(id)) attempts.set(id, { id: crypto.randomUUID(), text });
      attempts.delete(key); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts]));
      if (navigationRevision === submittedNavigation) { streamId = id; await refresh(); }
    }
    const attempt = attempts.get(id) ?? { id: crypto.randomUUID(), text };
    if (attempt.text !== text) throw Error('Retry the previous unconfirmed input before sending different work');
    attempts.set(id, attempt); sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = true;
    try { await request(`/api/workspace/streams/${id}/messages`, attempt); attempts.delete(id);
      if (projectId === submittedProject && navigationRevision === submittedNavigation) { if (input.value.trim() === text) input.value = ''; await refresh(); await selectStream(id); }
    }
    finally { sessionStorage.setItem('workspace.pending', JSON.stringify([...attempts])); send.disabled = false; }
    } finally { sending = false; renderTargets(); }
  })(); };
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); } };
  window.addEventListener('beforeunload', () => events?.close());
  await refresh(); await showWorkspace(true); await refreshAgents();
  return true;
}
