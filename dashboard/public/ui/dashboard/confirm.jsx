// Confirmation for a dashboard write (strict mode). Shows the tool and its arguments verbatim.
import React from 'react';
import { openWorkspaceDialog } from '../dialog.jsx';
import { buttonVariants } from '../shadcn/button';
import { describeArgs } from '../../confirm-args.js';

export function confirmDashboardWrite({ tool, args }) {
  const shown = describeArgs(args);
  // Arguments that cannot be shown completely are never approved: refuse without a dialog.
  if (!shown.ok) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false; const settle = value => { if (!settled) { settled = true; resolve(value); } };
    openWorkspaceDialog('Dashboard wants to change something', content => {
      const text = document.createElement('p'); text.textContent = `A dashboard asks to run "${tool}". It only runs if you confirm.`;
      const pre = document.createElement('pre'); pre.className = 'openui-confirm-args'; pre.textContent = shown.text;
      const actions = document.createElement('div'); actions.className = 'openui-confirm-actions';
      const no = document.createElement('button'); no.type = 'button'; no.textContent = 'Cancel'; no.className = buttonVariants({ variant: 'outline' });
      const yes = document.createElement('button'); yes.type = 'button'; yes.textContent = 'Run once'; yes.className = buttonVariants({ variant: 'default' });
      no.addEventListener('click', () => { settle(false); content.close(); });
      yes.addEventListener('click', () => { settle(true); content.close(); });
      actions.append(no, yes); content.append(text, pre, actions);
      // Closing the dialog any other way (Escape, ×) is a refusal.
      const watch = setInterval(() => { if (!content.open) { clearInterval(watch); settle(false); } }, 100);
    });
  });
}
