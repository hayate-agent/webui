import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function SessionCard({ session }) {
  return <section className="agent-card ui-session-card" aria-label={session.name || 'Unnamed PI session'}>
    <div className="ui-session-card-heading"><h3 data-session-name="">{session.name || 'Unnamed PI session'}</h3><span className={`ui-session-status ${session.chatStatus === 'active' ? 'active' : ''}`}>{session.chatStatus}</span></div>
    <p className="ui-session-location">{session.cwd}</p>
    <p className="ui-session-owner">{session.owner === 'disk' ? 'Saved history · read only' : `Connected · ${session.owner}`}</p>
    <p className="workspace-context ui-session-preview" data-session-preview="">Loading recent messages…</p>
    <div className="ui-session-actions">
      {session.owner !== 'disk' && <button type="button" data-session-rename="">Rename session</button>}
      <button type="button" className="ui-session-open" data-session-open="">{session.chatStatus === 'active' ? 'Go to chat' : 'Open as chat'}</button>
    </div>
  </section>;
}
export function createSessionCard(session, { rename, open }) {
  const template = document.createElement('template');
  template.innerHTML = renderToStaticMarkup(<SessionCard session={session} />);
  const row = template.content.firstElementChild;
  row.querySelector('[data-session-rename]')?.addEventListener('click', rename);
  row.querySelector('[data-session-open]').addEventListener('click', open);
  return { row, name: row.querySelector('[data-session-name]'), preview: row.querySelector('[data-session-preview]') };
}
