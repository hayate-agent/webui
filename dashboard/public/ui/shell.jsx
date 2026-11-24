import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button } from './shadcn/button';
import { Alert } from './shadcn/alert';
import { Input } from './shadcn/input';
import { Textarea } from './shadcn/textarea';

// The application frame as React + shadcn components. It keeps the ids and landmarks the
// imperative controllers (app.js, workspace-client.js, pi-client.js) bind to, so they keep working
// while their parts move into components one by one. `display: contents` lets `aside`/`main`
// stay direct grid children of <body>, exactly like the former static markup.
function Shell() {
  return <>
    <aside aria-label="Conversations">
      <div className="brand"><b id="brand-name">hayate</b> <span>local</span></div>
      <Button id="new" type="button" className="w-full justify-start">＋ New conversation</Button>
      <Input id="search" type="search" placeholder="Find a conversation" aria-label="Find a conversation" />
      <nav id="chats" aria-label="Conversation list" />
      <footer>No external services or browser-side keys.</footer>
    </aside>
    <main>
      <header>
        <h1 id="title">Hayate</h1>
        <div className="actions">
          <Button id="rename" type="button" variant="outline" size="sm" title="Rename conversation">Rename</Button>
          <Button id="export" type="button" variant="outline" size="sm" title="Export conversation as Markdown">Export</Button>
          <Button id="appearance" type="button" variant="outline" size="sm" title="Colours and names">Appearance</Button>
          <Button id="theme" type="button" variant="outline" size="icon" aria-label="Switch color scheme">◐</Button>
        </div>
      </header>
      <div id="connection" role="status">Connecting…</div>
      <section id="conversation" tabIndex={0} aria-label="Conversation"><div id="messages" /></section>
      <Button id="latest" type="button" variant="secondary" size="sm" hidden>↓ Jump to latest</Button>
      <section id="panels" aria-label="Extension panels" />
      <div id="activity" role="status" aria-live="polite" />
      <div id="module-actions" className="module-actions" aria-label="Extension actions" />
      <Alert id="error" variant="destructive" hidden />
      <form id="composer">
        <label className="sr-only" htmlFor="input">Message</label>
        <Textarea id="input" rows={3} placeholder="Ask Hayate, or use /help…" required />
        <div className="compose-actions">
          <span>Enter to send · Shift+Enter for a new line</span>
          <Button id="help" type="button" variant="ghost" size="sm">/help</Button>
          <Button id="stop" type="button" variant="outline" size="sm" title="Send /stop to this conversation">■ Stop</Button>
          <Button id="send" type="submit" size="sm">Send ↑</Button>
        </div>
      </form>
      <footer className="hint">Model and context settings remain owned by Hayate. Use /status, /model and /reasoning. · <span data-webui-version="">version …</span></footer>
    </main>
    <dialog id="rename-dialog">
      <form method="dialog">
        <label htmlFor="rename-input">Conversation title</label>
        <Input id="rename-input" maxLength={120} required />
        <div className="actions"><Button value="cancel" variant="outline" formNoValidate>Cancel</Button><Button value="save">Save</Button></div>
      </form>
    </dialog>
  </>;
}

/** Renders the frame synchronously; call before any controller looks up an element by id. */
export function mountShell(parent = document.body) {
  const host = document.createElement('div'); host.className = 'contents'; host.dataset.shell = '';
  parent.prepend(host);
  flushSync(() => createRoot(host).render(<Shell />));
  return host;
}
