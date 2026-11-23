// The sign-in and account dialogs are built imperatively by auth-client.js (which is also loaded
// stand-alone by unit tests, so it cannot import UI code). This observer gives them the shadcn
// field/button/alert classes, exactly like the Base UI dialogs.
import { styleDialogControls, styleAlert } from './ui/control-class.js';

function style(root) {
  for (const dialog of root.querySelectorAll?.('dialog.auth-dialog, dialog.account-dialog') ?? []) {
    if (dialog.dataset.ui === '1') continue;
    dialog.dataset.ui = '1';
    for (const alert of dialog.querySelectorAll('[role="alert"]')) styleAlert(alert);
    styleDialogControls(dialog);
    if (dialog.classList.contains('auth-dialog')) dialog.querySelector('button[type="submit"]')?.classList.add('w-full');
  }
}
export function styleAuthDialogs() {
  style(document);
  new MutationObserver(() => style(document)).observe(document.body, { childList: true, subtree: true });
}
