let signingIn;
let renewalEnabled = false, renewing = false, nextRenewal = 0;
// Only actual interaction renews idle time. Polling, SSE and synthetic events do not.
async function renewOnInteraction(event) {
  if (!event.isTrusted || document.visibilityState !== 'visible' || !renewalEnabled || signingIn || renewing || Date.now() < nextRenewal) return;
  renewing = true; nextRenewal = Date.now() + 60000;
  try { await call('/api/auth/renew', {}); }
  catch { nextRenewal = Date.now() + 10000; /* Do not replay work or force a login from this background request. */ }
  finally { renewing = false; }
}
for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, renewOnInteraction, { passive: true });
async function call(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error ?? 'Authentication failed'); return result;
}
export async function authenticate(force = false) {
  if (signingIn) return signingIn;
  const status = await call('/api/auth');
  if (signingIn) return signingIn;
  if (!status.required) return;
  if (!document.getElementById('sign-out')) {
    const logout = document.createElement('button'); logout.id = 'sign-out'; logout.textContent = 'Sign out';
    logout.onclick = async () => {
      renewalEnabled = false; logout.disabled = true;
      try {
        await call('/api/auth/logout', {});
        for (const key of Object.keys(sessionStorage)) if (key.startsWith('workspace.') || key.startsWith('hayate.webui.')) sessionStorage.removeItem(key);
        location.reload();
      } catch { renewalEnabled = true; logout.disabled = false; logout.textContent = 'Sign out failed · retry'; }
    };
    const settings = document.createElement('button'); settings.id = 'account-settings'; settings.textContent = 'Account settings';
    settings.onclick = () => { void accountSettings().catch(error => { settings.textContent = error.message; }); };
    document.querySelector('aside').append(settings, logout);
  }
  renewalEnabled = status.authenticated && !force;
  if (renewalEnabled) return;
  signingIn = new Promise(resolve => {
    document.body.classList.add('auth-locked');
    const dialog = document.createElement('dialog'); dialog.className = 'auth-dialog';
    const form = document.createElement('form'); const title = document.createElement('h2'); title.textContent = 'Operator sign in';
    const field = (label, type, autocomplete) => {
      const row = document.createElement('label'); row.textContent = label;
      const input = document.createElement('input'); input.type = type; input.autocomplete = autocomplete; input.required = true; row.append(input); form.append(row); return input;
    };
    form.append(title);
    const username = field('Username', 'text', 'username'); const password = field('Password', 'password', 'current-password');
    const error = document.createElement('p'); error.setAttribute('role', 'alert');
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Sign in'; form.append(error, submit);
    dialog.addEventListener('cancel', event => event.preventDefault());
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = '';
      try {
        const secret = password.value; password.value = '';
        await call('/api/auth/login', { username: username.value, password: secret });
        renewalEnabled = true; nextRenewal = Date.now() + 60000;
        dialog.close(); dialog.remove(); document.body.classList.remove('auth-locked'); resolve();
      } catch (failure) { error.textContent = failure.message; password.focus(); }
      finally { submit.disabled = false; }
    };
    dialog.append(form); document.body.append(dialog); dialog.showModal();
  }).finally(() => { signingIn = undefined; });
  return signingIn;
}
async function accountSettings() {
  const account = await call('/api/auth/account');
  const dialog = document.createElement('dialog'); dialog.className = 'account-dialog';
  const form = document.createElement('form');
  const title = document.createElement('h2'); title.textContent = 'Account settings'; form.append(title);
  const field = (label, type, autocomplete) => {
    const row = document.createElement('label'); row.textContent = label;
    const input = document.createElement('input'); input.type = type; input.autocomplete = autocomplete; row.append(input); form.append(row); return input;
  };
  const username = field('Login name', 'text', 'username'); username.value = account.username; username.required = true;
  const current = field('Current password', 'password', 'current-password'); current.required = true;
  const password = field('New password (leave empty to keep)', 'password', 'new-password');
  const confirmation = field('Confirm new password', 'password', 'new-password');
  const explanation = document.createElement('p'); explanation.textContent = 'Changes sign out all sessions. Credentials stay on the server and are never sent to a chat.';
  const error = document.createElement('p'); error.setAttribute('role', 'alert');
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save account'; save.disabled = !account.editable;
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  form.append(explanation, error, save, cancel);
  form.onsubmit = async event => {
    event.preventDefault(); error.textContent = '';
    if (password.value !== confirmation.value) { error.textContent = 'New passwords do not match'; return; }
    save.disabled = true;
    const input = { username: username.value, currentPassword: current.value, newPassword: password.value };
    current.value = ''; password.value = ''; confirmation.value = '';
    try { await call('/api/auth/account', input); location.reload(); }
    catch (failure) { error.textContent = failure.message; save.disabled = false; current.focus(); }
  };
  dialog.append(form); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
}
export async function checkIdentity() {
  const status = await call('/api/auth');
  if (status.required && !status.authenticated) { await authenticate(); location.reload(); }
}
