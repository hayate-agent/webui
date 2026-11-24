import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button } from './shadcn/button';
import { NativeSelect } from './shadcn/native-select';

// Uncontrolled editor deliberately retains browser selection/IME and the existing
// per-conversation draft controller. React owns the component structure.
export function createComposer() {
  const host = document.createElement('div'); host.className = 'ui-composer-host';
  const refs = {};
  flushSync(() => createRoot(host).render(<>
    <form className="workspace-composer ui-composer bui-composer" ref={element => { refs.composer = element; }}>
      <div className="bui-composer-caption"><span>Nachricht verfassen</span><span>PI · Hayate</span></div>
      <div ref={element => { refs.attachments = element; }} aria-label="Attached images" />
      <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden ref={element => { refs.files = element; }} />
      <textarea ref={element => { refs.input = element; }} rows={3} aria-label="Next project step" placeholder="Message your agent…" />
      <div className="ui-composer-toolbar">
        <label className="ui-delivery-label" ref={element => { refs.modeLabel = element; }}>
          <span className="sr-only">Delivery</span>
          <NativeSelect aria-label="PI delivery mode" defaultValue="steer" ref={element => { refs.piMode = element; }}>
            <option value="steer">Steer current work</option>
            <option value="followUp">Follow up</option>
            <option value="">Send when idle</option>
          </NativeSelect>
        </label>
        <Button variant="outline" size="icon" type="button" ref={element => { refs.attach = element; }} aria-label="Attach images" title="Bild anhängen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg></Button>
        <span className="ui-composer-hint">Enter to send · Shift + Enter for a new line</span>
        <Button variant="outline" size="icon" type="button" ref={element => { refs.piStop = element; }} aria-label="Stop PI" title="PI stoppen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg></Button>
        <Button type="submit" ref={element => { refs.send = element; }} aria-label="Send ↑" title="Senden (Enter)"><span className="ui-send-label">Senden</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg></Button>
      </div>
    </form>
    <footer className="ui-app-footer"><span data-webui-version="">WebUI version …</span></footer>
  </>));
  refs.piMode.hidden = true; refs.piStop.hidden = true;
  return { host, ...refs };
}
