// PI remains an independent backend beside Hayate, never a replacement toggle.
export async function mountPi({ request, markdown, label = 'Local PI', poll = false }) {
  let initial;
  try { initial = await request('/api/pi/sessions'); } catch { return; }
  const section = document.createElement('section');
  const heading = document.createElement('h2'); heading.textContent = label;
  const list = document.createElement('div'), view = document.createElement('dialog');
  view.className = 'workspace-dialog';
  const title = document.createElement('h2'), transcript = document.createElement('section'), status = document.createElement('p');
  const dialogs = document.createElement('section');
  const input = document.createElement('textarea'); input.rows = 4;
  const mode = document.createElement('select');
  for (const [value, label] of [['', 'Send when idle'], ['steer', 'Steer current work'], ['followUp', 'Follow up']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; mode.append(option); }
  const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = () => Promise.resolve().then(action).catch(error => { status.textContent = error.message; }); return node; };
  let selected, rendering = false, dirty = false, liveText = '';
  const dialogNodes = new Map();
  const renderDialogs = pending => {
    const keep = new Set(pending.map(dialog => dialog.id));
    for (const [id, node] of dialogNodes) if (!keep.has(id)) { node.remove(); dialogNodes.delete(id); }
    for (const dialog of pending) {
      if (dialogNodes.has(dialog.id)) continue;
      const form = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = dialog.title || 'PI question'; form.append(legend);
      if (dialog.message) { const message = document.createElement('p'); message.textContent = dialog.message; form.append(message); }
      const session = selected;
      const respond = async answer => {
        form.disabled = true;
        try { await request(`/api/pi/sessions/${session}/dialog`, { id: dialog.id, answer }); form.remove(); }
        catch (error) { form.disabled = false; throw error; }
      };
      if (dialog.method === 'confirm') form.append(button('Confirm', () => respond({ confirmed: true })), button('Decline', () => respond({ confirmed: false })));
      else if (dialog.method === 'select') for (const option of dialog.options ?? []) form.append(button(option, () => respond({ value: option })));
      else {
        const editor = document.createElement(dialog.method === 'editor' ? 'textarea' : 'input'); editor.value = dialog.prefill ?? ''; editor.placeholder = dialog.placeholder ?? ''; form.append(editor, button('Answer PI', () => respond({ value: editor.value })));
      }
      form.append(button('Cancel question', () => respond({ cancelled: true })));
      dialogNodes.set(dialog.id, form); dialogs.append(form);
    }
  };
  const paintLive = () => {
    let live = transcript.querySelector('[data-pi-live]');
    if (!liveText) { live?.remove(); return; }
    if (!live) { live = document.createElement('pre'); live.dataset.piLive = '1'; transcript.append(live); }
    live.textContent = liveText;
  };
  const refresh = async () => {
    if (!selected || !view.open) return;
    if (rendering) { dirty = true; return; }
    rendering = true;
    try {
      do {
        dirty = false; const id = selected;
        const snapshot = await request(`/api/pi/sessions/${id}`);
        if (id !== selected) continue;
        transcript.replaceChildren(...snapshot.messages.map(message => { const row = document.createElement('article'); row.className = `message ${message.role}`; const label = document.createElement('small'); label.textContent = message.role; row.append(label, markdown(message.text)); return row; }));
        renderDialogs(snapshot.dialogs ?? []);
        if (poll) liveText = snapshot.liveText ?? '';
        paintLive();
        send.disabled = snapshot.readOnly === true;
        input.disabled = snapshot.readOnly === true;
        status.textContent = snapshot.readOnly ? 'Read-only local history · connect its owning PI terminal to work in this session' : snapshot.busy ? 'PI working · choose Steer or Follow up for additional input' : 'PI idle';
      } while (dirty);
    } finally { rendering = false; }
  };
  const send = button('Send', async () => {
    if (!selected || !input.value.trim()) return;
    const submittedSession = selected, submittedText = input.value, submittedMode = mode.value;
    send.disabled = true;
    try {
      await request(`/api/pi/sessions/${submittedSession}/prompt`, { text: submittedText, ...(submittedMode ? { mode: submittedMode } : {}) });
      if (selected === submittedSession && input.value === submittedText) input.value = '';
      if (selected === submittedSession) await refresh();
    } finally { if (selected === submittedSession) send.disabled = input.disabled; }
  });
  const open = async session => { liveText = ''; dialogNodes.clear(); dialogs.replaceChildren(); selected = session.id; title.textContent = `${session.name} · ${session.cwd}`; transcript.replaceChildren(); status.textContent = ''; if (!view.open) view.showModal(); await refresh(); };
  const renderList = sessions => list.replaceChildren(...sessions.map(session => button(`${session.name} · ${session.owner} · ${session.cwd}`, () => open(session))));
  const create = button('＋ New PI session', async () => {
    const cwd = window.prompt('PI working directory (inside configured roots)', initial.roots[0]);
    if (!cwd) return;
    const result = await request('/api/pi/sessions', { cwd });
    const next = await request('/api/pi/sessions'); renderList(next.sessions);
    await open(next.sessions.find(session => session.id === result.id));
  });
  view.append(title, status, transcript, dialogs, input, mode, send, button('Stop PI', async () => { await request(`/api/pi/sessions/${selected}/abort`, {}); await refresh(); }), button('Release RPC to native console', async () => {
    const result = await request(`/api/pi/sessions/${selected}/release`, {});
    input.disabled = true; send.disabled = true;
    // Show structured argv, not an interpolated shell command with unsafe paths.
    status.textContent = `RPC exited. In ${result.cwd}, run executable ${result.executable} with arguments ${JSON.stringify(result.args)}. Resume only once.`;
  }), button('Close', () => view.close()));
  section.append(heading, create, list); document.querySelector('aside').append(section); document.body.append(view);
  renderList(initial.sessions);
  if (poll) {
    let running = false;
    const timer = setInterval(async () => {
      if (document.hidden || running) return;
      running = true;
      try { const next = await request('/api/pi/sessions'); renderList(next.sessions); await refresh(); }
      catch (error) { if (view.open) status.textContent = error.message; }
      finally { running = false; }
    }, 1500);
    window.addEventListener('beforeunload', () => clearInterval(timer));
    return;
  }
  const events = new EventSource('/api/pi/events');
  events.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.type === 'sessions') renderList(value.sessions);
    if (value.sessionId !== selected || !view.open) return;
    if (value.event?.type === 'message_update' && value.event.assistantMessageEvent?.type === 'text_delta') {
      status.textContent = 'PI streaming…';
      liveText += value.event.assistantMessageEvent.delta; paintLive();
    } else if (['message_end', 'agent_settled'].includes(value.event?.type)) {
      liveText = ''; void refresh().catch(error => { status.textContent = error.message; });
    }
    else if (value.event?.type === 'extension_ui_request' || value.event?.type === 'dialog_answered') void refresh().catch(error => { status.textContent = error.message; });
    else if (value.event?.type === 'ui_prompt_start') status.textContent = 'PI needs interaction in its owning terminal; TUI dialog arbitration is not implemented yet.';
  };
  events.onopen = () => {
    liveText = ''; paintLive();
    void refresh().catch(error => { if (view.open) status.textContent = error.message; });
  };
  events.onerror = () => { if (view.open) status.textContent = 'PI bridge disconnected; no work automatically resubmitted'; };
  window.addEventListener('beforeunload', () => events.close());
}
