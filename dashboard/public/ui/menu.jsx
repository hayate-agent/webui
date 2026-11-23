import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu } from '@base-ui/react/menu';
import { MenuContent, MenuItem } from './shadcn/menu';

function ActionPopup({ anchor, items, dispose, onError }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('[role="menuitem"]')?.focus(); }, []);
  return <MenuContent ref={ref} className="workspace-menu ui-action-menu" finalFocus={() => anchor}>
    {items.map(([label, action]) => <MenuItem key={label} destructive={label.startsWith('Delete')} onClick={() => {
      dispose(); Promise.resolve().then(action).catch(onError);
    }}>{label}</MenuItem>)}
  </MenuContent>;
}
// Shared accessible primitive: Base UI owns focus, keyboard navigation,
// dismissal and viewport collision handling, not hand-written menu logic.
let disposeCurrent;
export function openActionMenu(anchor, items, onError, pointer, align = 'start') {
  disposeCurrent?.();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    queueMicrotask(() => { root.unmount(); host.remove(); anchor?.focus(); });
    if (disposeCurrent === dispose) disposeCurrent = undefined;
  };
  disposeCurrent = dispose;
  const virtualAnchor = pointer ? { getBoundingClientRect: () => new DOMRect(pointer.x, pointer.y, 0, 0) } : anchor;
  root.render(
    <Menu.Root open onOpenChange={open => { if (!open) dispose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={virtualAnchor} sideOffset={6} align={align} collisionPadding={8} style={{ zIndex: 100 }}>
          <ActionPopup anchor={anchor} items={items} dispose={dispose} onError={onError} />
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
