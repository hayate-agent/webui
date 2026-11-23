import React, { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog } from '@base-ui/react/dialog';
import { styleDialogControls } from './control-class.js';

function Content({ content }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    host.current.append(content);
    // Controls the builders create imperatively get their shadcn classes whenever the content changes.
    styleDialogControls(content);
    const observer = new MutationObserver(() => styleDialogControls(content));
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [content]);
  return <div ref={host} className="ui-dialog-content" />;
}
// Compatibility boundary while individual forms move to React components.
// Base UI owns modality, focus trapping, Escape and accessible title linkage.
export function openWorkspaceDialog(title, build) {
  const content = document.createElement('div');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  Object.defineProperty(content, 'open', { get: () => !closed });
  content.close = () => {
    if (closed) return; closed = true;
    queueMicrotask(() => { root.unmount(); host.remove(); });
  };
  build(content);
  flushSync(() => root.render(
    <Dialog.Root open onOpenChange={open => { if (!open) content.close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="workspace-dialog ui-library-dialog" initialFocus={() => content.querySelector('input,textarea,select') ?? true}>
          <div className="ui-dialog-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close aria-label="Close">×</Dialog.Close></div>
          <Content content={content} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  ));
  return content;
}
