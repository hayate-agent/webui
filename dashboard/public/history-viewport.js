// Variable-height history window: only nearby messages own DOM nodes.
// Message data and measured heights are separate from the rendered window.
export function createHistoryViewport({ render, scroller, onEarlier, windowSize = 32, maxRows = 120 }) {
  const element = document.createElement('div');
  element.className = 'history-viewport';
  const top = document.createElement('div'), rows = document.createElement('div'), bottom = document.createElement('div');
  top.setAttribute('aria-hidden', 'true'); bottom.setAttribute('aria-hidden', 'true');
  element.append(top, rows, bottom);
  const heights = new Map(), nodes = new Map(), disclosures = new Map(), signatures = new WeakMap();
  const signatureOf = message => { let value = signatures.get(message); if (value === undefined) { value = JSON.stringify(message); signatures.set(message, value); } return value; };
  // The browser's own scroll anchoring would double-compensate our manual correction.
  scroller.style.overflowAnchor = 'none';
  let messages = [], start = -1, end = -1, frame, disposed = false, loading = false, userScrolled = false, measuring = false;
  const resize = new ResizeObserver(() => { if (!disposed) { measuring = true; schedule(); } });
  resize.observe(rows); resize.observe(scroller);
  const markInteraction = event => {
    if (event.type === 'wheel' && event.deltaY < 0 || event.type === 'touchmove' || event.type === 'keydown' && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { userScrolled = true; schedule(); }
  };
  for (const name of ['wheel', 'touchmove', 'keydown']) scroller.addEventListener(name, markInteraction, { passive: true });
  // Unmeasured rows use the mean of measured ones, so spacers stay close to reality
  // (a fixed guess far from the real height shows as blank space while scrolling).
  let measuredSum = 0, measuredCount = 0;
  const estimate = () => measuredCount ? Math.max(24, measuredSum / measuredCount) : 120;
  const height = message => heights.get(message.id) ?? estimate();
  const offset = () => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  function paint(force = false) {
    if (disposed || !element.isConnected) return;
    paintOnce(force);
    // A spacer that is still visible after measuring is blank screen: settle at once.
    for (let i = 0; i < 4 && blankVisible(); i++) paintOnce(true);
  }
  function blankVisible() {
    const box = scroller.getBoundingClientRect();
    const covers = el => { const r = el.getBoundingClientRect(); return r.height > 1 && Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 1; };
    return (start > 0 && covers(top)) || (end < messages.length && covers(bottom));
  }
  function paintOnce(force) {
    const y = Math.max(0, scroller.scrollTop - offset());
    let position = 0, first = 0;
    while (first < messages.length - 1 && position + height(messages[first]) < y) position += height(messages[first++]);
    const nextStart = Math.max(0, Math.min(first - 6, messages.length - windowSize));
    // The window always covers the visible area plus one screen of overscan, however
    // small the rows are; the DOM stays bounded by `maxRows`, not by a fixed 32.
    const reach = y + scroller.clientHeight * 2;
    let nextEnd = Math.min(messages.length, nextStart + windowSize), covered = 0;
    for (let i = 0; i < nextStart; i++) covered += height(messages[i]);
    for (let i = nextStart; i < nextEnd; i++) covered += height(messages[i]);
    while (nextEnd < messages.length && nextEnd - nextStart < maxRows && covered < reach) covered += height(messages[nextEnd++]);
    if (!force && nextStart === start && nextEnd === end) return;
    // Rows above the viewport are measured only once they were mounted. When a
    // row turns out taller than its estimate the spacer grows; without correcting
    // scrollTop the content under the finger jumps ("display suddenly speeds up").
    const scrollerTop = scroller.getBoundingClientRect().top;
    const anchorNode = [...rows.children].find(node => node.getBoundingClientRect().bottom > scrollerTop);
    const anchorId = anchorNode?.dataset.historyId, anchorOffset = anchorNode ? anchorNode.getBoundingClientRect().top - scrollerTop : 0;
    start = nextStart; end = nextEnd;
    const visible = messages.slice(start, end), active = new Set(visible.map(message => message.id));
    for (const [id, cached] of nodes) if (!active.has(id)) {
      for (const details of cached.node.querySelectorAll('details[data-disclosure-id]')) disclosures.set(details.dataset.disclosureId, details.open);
      nodes.delete(id);
    }
    const fragment = document.createDocumentFragment();
    for (const message of visible) {
      const signature = signatureOf(message);
      let cached = nodes.get(message.id);
      if (!cached || cached.signature !== signature) {
        if (cached) for (const details of cached.node.querySelectorAll('details[data-disclosure-id]')) disclosures.set(details.dataset.disclosureId, details.open);
        const node = render(message); node.dataset.historyId = message.id;
        for (const details of node.querySelectorAll('details[data-disclosure-id]')) if (disclosures.has(details.dataset.disclosureId)) details.open = disclosures.get(details.dataset.disclosureId);
        cached = { node, signature }; nodes.set(message.id, cached);
      }
      fragment.append(cached.node);
    }
    rows.replaceChildren(fragment);
    // Row pitch = distance to the next row's top (adjacent margins collapse, so adding
    // both margins would overstate the height and shift every later position).
    const mounted = visible.map(message => nodes.get(message.id).node);
    mounted.forEach((node, index) => {
      const id = visible[index].id, box = node.getBoundingClientRect(), next = mounted[index + 1]?.getBoundingClientRect();
      const pitch = Math.max(1, next ? next.top - box.top : box.height + (parseFloat(getComputedStyle(node).marginBottom) || 0));
      if (heights.has(id)) measuredSum -= heights.get(id); else measuredCount++;
      heights.set(id, pitch); measuredSum += pitch;
    });
    top.style.height = `${messages.slice(0, start).reduce((sum, message) => sum + height(message), 0)}px`;
    bottom.style.height = `${messages.slice(end).reduce((sum, message) => sum + height(message), 0)}px`;
    const kept = anchorId === undefined ? undefined : nodes.get(anchorId)?.node;
    if (kept?.isConnected) {
      const drift = kept.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorOffset;
      if (Math.abs(drift) > 0.5) scroller.scrollTop += drift;
    }
  }
  function scrollToEnd() {
    for (let i = 0; i < 4; i++) {
      const before = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight; paint(true);
      if (scroller.scrollHeight === before) break;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }
  function schedule() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = undefined; const force = measuring; measuring = false; paint(force);
      if (userScrolled && scroller.scrollTop < 100 && onEarlier && !loading) {
        loading = true; userScrolled = false;
        Promise.resolve().then(onEarlier).finally(() => { loading = false; }).catch(() => {});
      }
    });
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  return {
    element,
    update(next) {
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 70;
      // Preserve an actual visible row across prepends and changed estimates.
      const anchor = [...rows.children].find(node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
      const anchorId = anchor?.dataset.historyId, anchorTop = anchor?.getBoundingClientRect().top;
      const previous = messages;
      messages = next;
      const valid = new Set(messages.map(message => message.id));
      for (const [id, value] of heights) if (!valid.has(id)) { heights.delete(id); measuredSum -= value; measuredCount--; }
      if (anchorId && previous[0]?.id !== next[0]?.id) {
        const index = messages.findIndex(message => message.id === anchorId);
        if (index >= 0) scroller.scrollTop = offset() + messages.slice(0, index).reduce((sum, message) => sum + height(message), 0);
      }
      paint(true);
      // Following the newest message wins over keeping an anchor: a reader at the
      // bottom (or one who just sent a message) must see the answer arrive.
      if (atBottom) scrollToEnd();
      else if (anchorId) {
        const current = nodes.get(anchorId)?.node;
        if (current) scroller.scrollTop += current.getBoundingClientRect().top - anchorTop;
      }
    },
    refresh: () => paint(true),
    // Scrolls to the newest row and repeats until measured heights settle, so the
    // view never lands in the middle because unmeasured rows were estimated.
    scrollToEnd,
    destroy() { disposed = true; resize.disconnect(); scroller.removeEventListener('scroll', schedule); for (const name of ['wheel', 'touchmove', 'keydown']) scroller.removeEventListener(name, markInteraction); if (frame) cancelAnimationFrame(frame); nodes.clear(); heights.clear(); disclosures.clear(); },
  };
}
