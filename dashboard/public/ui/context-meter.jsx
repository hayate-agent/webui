import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Same figures and thresholds as PI's TUI footer: ↑input ↓output Rcache-read $cost, then
// context percent / window (warning above 70 %, error above 90 %).
export function formatTokens(count) {
  if (!Number.isFinite(count)) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}
function Meter({ usage }) {
  const { totals = {}, tokens, contextWindow, percent } = usage;
  const known = typeof percent === 'number';
  const tone = !known ? 'bg-ink-2/40' : percent > 90 ? 'bg-destructive' : percent > 70 ? 'bg-[#b7791f]' : 'bg-primary';
  const label = known ? `${percent.toFixed(1)}%/${formatTokens(contextWindow)}` : tokens != null ? `${formatTokens(tokens)} tokens` : '?';
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2" data-context-meter="">
    <span className="font-mono tabular-nums" title="Input / output / cache read tokens and cost of this session">
      {totals.input ? `↑${formatTokens(totals.input)} ` : ''}{totals.output ? `↓${formatTokens(totals.output)} ` : ''}{totals.cacheRead ? `R${formatTokens(totals.cacheRead)} ` : ''}{totals.cost ? `$${totals.cost.toFixed(3)}` : ''}
    </span>
    <span className="flex items-center gap-2" title="Context window fill level">
      <span role="progressbar" aria-label="Context window usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(percent) : undefined} className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
        <span data-fill={known ? Math.max(2, Math.min(100, percent)) : 0} className={`block h-full rounded-full ${tone}`} />
      </span>
      <span className="font-mono tabular-nums">{label}</span>
    </span>
    {usage.model ? <span className="truncate font-mono" title="Model">{usage.model}{usage.thinkingLevel ? ` · ${usage.thinkingLevel}` : ''}</span> : null}
  </div>;
}
export function renderContextMeter(usage) {
  const template = document.createElement('template');
  template.innerHTML = renderToStaticMarkup(<Meter usage={usage} />);
  const root = template.content.firstElementChild;
  // The CSP forbids inline style attributes (also from innerHTML); CSSOM writes are allowed.
  for (const fill of root.querySelectorAll('[data-fill]')) fill.style.width = `${fill.dataset.fill}%`;
  return root;
}
