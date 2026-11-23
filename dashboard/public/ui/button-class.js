// shadcn button variants for imperatively created DOM (sidebar rows, drawer toggle).
// Lives under ui/ so Tailwind's @source scan generates every class used here.
// `cn` (tailwind-merge) resolves conflicts with the variant base (nowrap vs normal, flex vs line-clamp).
// Sizes are fixed px: the app root font is 15px, so rem-based h-9/h-11 would come out smaller.
import { buttonVariants } from './shadcn/button';
import { cn } from '../lib/utils';

/** Ghost row button for conversation titles: wraps to at most three lines. */
export const rowButtonClass = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto min-h-[36px] w-full min-w-0 justify-start whitespace-normal break-words text-left text-[13px] font-normal leading-[1.45] line-clamp-3');
/** Agent heading: wraps, muted. */
export const headingButtonClass = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto min-h-[36px] w-full min-w-0 justify-start whitespace-normal break-words text-left text-xs font-medium text-ink-2');
/** Compact icon button for per-row actions and the "+" action. */
export const iconButtonClass = cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-[36px] w-[36px] shrink-0 text-ink-2');
/** Outline icon button: the mobile drawer toggle. */
// Hidden by default (desktop); the viewport media query below shows it, so no legacy rule is involved.
export const navToggleClass = cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'hidden max-[760px]:inline-flex h-[44px] w-[44px] shrink-0');

/** Sidebar action rows ("New project", "Agents", "Hidden items…"): full-width outline-free ghost buttons. */
export const actionRowClass = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-[36px] w-full min-w-0 justify-start text-[13px] font-medium text-ink-2');
/** Project row disclosure chevron. */
export const disclosureClass = cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-[36px] w-[28px] shrink-0 text-ink-2');
