// shadcn classes for controls created imperatively (dialog forms, pickers, inline editors).
// They are built from the real shadcn sources (button.tsx, input.tsx, textarea.tsx) so there is one
// source of truth; this file lives under ui/ so Tailwind's @source scan generates every class.
import { buttonVariants } from './shadcn/button';
import { inputClassName, textareaClassName, nativeSelectClassName } from './shadcn/field-classes';
import { cn } from '../lib/utils';

const INPUT = inputClassName;
export const inputClass = INPUT;
export const selectClass = nativeSelectClassName;
export const textareaClass = cn(textareaClassName, 'min-h-[70px]');
export const primaryButtonClass = buttonVariants({ variant: 'default', size: 'sm' });
export const outlineButtonClass = buttonVariants({ variant: 'outline', size: 'sm' });

const byTag = { input: inputClass, select: selectClass, textarea: textareaClass };
/** Adds the shadcn field classes to a freshly created control; buttons/checkboxes are left to their context. */
export function styleControl(element) {
  const base = byTag[element.localName];
  if (base && !['checkbox', 'radio', 'file', 'hidden'].includes(element.type)) element.className = cn(base, element.className);
  return element;
}
/** Dialog content: class-less buttons are outline, submit buttons primary (shadcn Button variants). */
export function styleDialogControls(root) {
  for (const control of root.querySelectorAll('input,select,textarea')) if (control.dataset.ui !== '1') { styleControl(control); control.dataset.ui = '1'; }
  for (const button of root.querySelectorAll('button')) {
    if (button.dataset.ui === '1') continue;
    button.dataset.ui = '1';
    if (!button.className) button.className = button.type === 'submit' ? primaryButtonClass : outlineButtonClass;
  }
}
