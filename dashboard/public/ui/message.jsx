import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// TUI-like transcript: assistant text flows without a card, the user's message is a
// tinted block, tool calls are compact mono lines with the output folded underneath.
const MARK = { thinking: '∴', call: '●', result: '↳', failed: '✕' };
function preview(args) {
  if (!args || typeof args !== 'object') return '';
  const first = ['command', 'path', 'file_path', 'pattern', 'query', 'url'].map(key => args[key]).find(value => typeof value === 'string') ?? Object.values(args).find(value => typeof value === 'string') ?? '';
  const line = first.split('\n')[0];
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}
function Disclosure({ label, hint, text, identity, expanded, kind }) {
  return <details data-disclosure-id={identity} open={expanded.has(identity)} className={`ui-message-disclosure ${kind}`}>
    <summary><span className="ui-disclosure-indicator" aria-hidden="true">{MARK[kind]}</span><span className="ui-disclosure-label">{label}</span>{hint ? <span className="ui-disclosure-hint" data-text={hint} aria-hidden="true" /> : null}</summary><pre>{text}</pre>
  </details>;
}
export function Message({ message, expanded }) {
  const role = message.role === 'toolResult' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'You';
  return <article className={`message ${message.role} ui-chat-message`} data-message-id={message.id}>
    <span className="sr-only">{role}</span>
    {message.thinking && <Disclosure label="Thinking" text={message.thinking} identity={`${message.id}:thinking`} expanded={expanded} kind="thinking" />}
    {message.role === 'toolResult'
      ? <Disclosure label={`${message.isError ? 'Failed' : 'Result'} · ${message.toolName ?? 'tool'}`} hint={(message.text ?? '').split('\n')[0].slice(0, 90)} text={message.text} identity={`${message.id}:result`} expanded={expanded} kind={message.isError ? 'failed' : 'result'} />
      : <>
        {message.text && (message.role === 'assistant' ? <div data-markdown-slot="" /> : <p>{message.text}</p>)}
        {(message.toolCalls ?? []).map(call => <Disclosure key={call.id} label={`Tool · ${call.name}`} hint={preview(call.arguments)} text={JSON.stringify(call.arguments, null, 2)} identity={`${message.id}:${call.id}`} expanded={expanded} kind="call" />)}
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
