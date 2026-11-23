import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Transcript like PI's TUI: nothing is hidden behind a card. Assistant text flows,
// the user's message is a tinted block, a tool call is one mono line
// (`● bash  ls -la`) followed directly by its output (first lines visible, the
// rest behind "… N more lines"), thinking is muted italic text.
const PREVIEW_LINES = 10, THINKING_LINES = 8;
// Adapters and agents ship tool arguments as bounded JSON text (live events) or as
// `{ preview: "<json>" }` (history pages). Show the command/path like the PI TUI,
// never the JSON itself.
function structured(args) {
  if (args && typeof args === 'object' && Object.keys(args).length === 1 && typeof args.preview === 'string') args = args.preview;
  if (typeof args !== 'string') return args;
  const text = args.trim();
  if (!/^[{[]/.test(text)) return args;
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === 'object' ? parsed : args; }
  catch {
    // Bounded text may be cut mid-JSON: recover the first string value.
    const match = /"(?:command|path|file_path|pattern|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text) ?? /"[^"]+"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
    if (!match) return args;
    try { return { command: JSON.parse(`"${match[1].replace(/\\$/, '')}"`) }; } catch { return { command: match[1] }; }
  }
}
export function preview(raw) {
  const args = structured(raw);
  if (typeof args === 'string') return args.split('\n')[0].slice(0, 160);
  if (!args || typeof args !== 'object') return '';
  const first = ['command', 'path', 'file_path', 'pattern', 'query', 'url'].map(key => args[key]).find(value => typeof value === 'string') ?? Object.values(args).find(value => typeof value === 'string') ?? '';
  const line = first.split('\n')[0];
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
function Lines({ text, limit, identity, expanded, className }) {
  const lines = String(text ?? '').replace(/\n+$/, '').split('\n');
  if (lines.length <= limit) return <pre className={className}>{lines.join('\n')}</pre>;
  const shown = lines.slice(0, limit).join('\n'), rest = lines.slice(limit);
  return <>
    <pre className={className}>{shown}</pre>
    <details data-disclosure-id={identity} open={expanded.has(identity)} className="tui-more">
      <summary>{`… ${rest.length} more line${rest.length === 1 ? '' : 's'}`}</summary>
      <pre className={className}>{rest.join('\n')}</pre>
    </details>
  </>;
}
// PI shows `Took 4.2s` / `Elapsed 4.2s`; messages carry a local time of day.
export function took(durationMs, running) {
  if (!Number.isFinite(durationMs)) return '';
  const s = durationMs / 1000;
  const text = s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${running ? 'Elapsed' : 'Took'} ${text}`;
}
/** Keeps `Elapsed` of running tools counting without re-rendering the conversation. */
export function tickElapsed(root, now = Date.now()) {
  for (const element of root.querySelectorAll('[data-since]')) element.textContent = took(Math.max(0, now - Number(element.dataset.since)), true);
}
export function clock(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${time}`;
}
function Images({ images, messageId }) {
  if (!images?.length) return null;
  return <div className="tui-images">{images.map((image, index) => <span key={index} className="tui-image" data-image-slot="" data-message-id={messageId} data-image-index={index}>
    <button type="button" className="tui-image-open">{`🖼 ${image.mimeType || 'image'} · ${Math.max(1, Math.round((image.bytes ?? 0) / 1024))} KB · show`}</button>
  </span>)}</div>;
}
export function ToolLine({ name, args, status, durationMs, startedAt }) {
  const failed = status === 'failed', running = status === 'running';
  return <div className={`tui-tool ${failed ? 'failed' : running ? 'running' : ''}`}>
    <span className="tui-mark" aria-hidden="true">{failed ? '✕' : running ? '◌' : '●'}</span>
    <span className="tui-tool-name">{name}</span>
    {args ? <span className="tui-tool-args">{name === 'bash' ? `$ ${preview(args)}` : preview(args)}</span> : null}
    {durationMs != null ? <span className="tui-tool-time">{took(durationMs, running)}</span>
      : running && Number.isFinite(startedAt) ? <span className="tui-tool-time" data-since={startedAt}>{took(Math.max(0, Date.now() - startedAt), true)}</span> : null}
  </div>;
}
export function Message({ message, expanded }) {
  const role = message.role === 'toolResult' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'You';
  return <article className={`message ${message.role} ui-chat-message`} data-message-id={message.id}>
    <span className="sr-only">{role}</span>
    {message.timestamp && message.role !== 'toolResult' ? <time className="tui-time" dateTime={String(message.timestamp)}>{clock(message.timestamp)}</time> : null}
    {message.thinking ? <div className="tui-thinking"><Lines text={message.thinking} limit={THINKING_LINES} identity={`${message.id}:thinking`} expanded={expanded} /></div> : null}
    {message.role === 'toolResult'
      ? <div className={`tui-result ${message.isError ? 'failed' : 'ok'}`}><Lines text={message.text} limit={PREVIEW_LINES} identity={`${message.id}:result`} expanded={expanded} className="tui-output" /><Images images={message.images} messageId={message.id} />{message.durationMs != null ? <div className="tui-took">{took(message.durationMs, false)}</div> : null}</div>
      : <>
        {message.text && (message.role === 'assistant' ? <div data-markdown-slot="" /> : <p>{message.text}</p>)}
        <Images images={message.images} messageId={message.id} />
        {(message.toolCalls ?? []).map(call => <ToolLine key={call.id} name={call.name} args={call.arguments} />)}
      </>}
  </article>;
}
// Static React output deliberately keeps native details interactive without one
// React root per history message. Never inject model text as raw HTML: React
// escapes it; assistant markdown uses the existing sanitized DOM renderer.
export function renderChatMessage(message, expanded, markdown) {
  const template = document.createElement('template');
  template.innerHTML = renderToStaticMarkup(<Message message={message} expanded={expanded} />);
  const row = template.content.firstElementChild;
  row.querySelector('[data-markdown-slot]')?.replaceWith(markdown(message.text));
  return row;
}
// Live (not yet persisted) activity uses the very same markup as history.
// First sight of a running tool, per id, bounded: PI shows `Elapsed` from the start of the call.
const firstSeen = new Map();
export function renderLiveTool(tool, now = Date.now()) {
  let startedAt = tool.startedAt;
  if (tool.status === 'running' && !Number.isFinite(startedAt)) {
    if (!firstSeen.has(tool.id)) { firstSeen.set(tool.id, now); if (firstSeen.size > 64) firstSeen.delete(firstSeen.keys().next().value); }
    startedAt = firstSeen.get(tool.id);
  }
  const template = document.createElement('template');
  template.innerHTML = renderToStaticMarkup(<ToolLine name={tool.name} args={tool.arguments} status={tool.status} durationMs={tool.durationMs} startedAt={startedAt} />);
  return template.content.firstElementChild;
}
export function renderLiveThinking(text, expanded) {
  const template = document.createElement('template');
  template.innerHTML = renderToStaticMarkup(<div className="tui-thinking"><Lines text={text} limit={THINKING_LINES} identity="live:thinking" expanded={expanded} /></div>);
  return template.content.firstElementChild;
}
