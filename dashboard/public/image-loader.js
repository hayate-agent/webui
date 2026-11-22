// Lazy, bounded image display. Page payloads never carry image bytes: a message only
// lists what exists; the viewer fetches one block in small chunks on demand, assembles a
// Blob URL and keeps at most MAX_BLOBS of them (older ones are revoked and reloadable).
export const MAX_BLOBS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHUNKS = 128;
export function createImageLoader({ fetchChunk, createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url), max = MAX_BLOBS }) {
  const urls = new Map(), loading = new Map();
  const keyOf = (scope, messageId, index) => `${scope.agentId}\n${scope.streamId}\n${messageId}\n${index}`;
  const remember = (key, url) => {
    urls.delete(key); urls.set(key, url);
    while (urls.size > max) { const [oldest, old] = urls.entries().next().value; urls.delete(oldest); revokeUrl(old); }
  };
  const decode = chunks => Uint8Array.from(atob(chunks.join('')), char => char.charCodeAt(0));
  async function load(scope, messageId, index) {
    const key = keyOf(scope, messageId, index);
    if (urls.has(key)) { const url = urls.get(key); urls.delete(key); urls.set(key, url); return url; }
    if (loading.has(key)) return loading.get(key);
    const work = (async () => {
      const parts = []; let offset = 0, size = Infinity, type;
      for (let i = 0; i < MAX_CHUNKS; i++) {
        const chunk = await fetchChunk({ messageId, index, offset }, scope);
        if (!chunk || typeof chunk.data !== 'string' || !/^image\/(png|jpeg|webp)$/.test(chunk.mimeType) || chunk.offset !== offset || !Number.isSafeInteger(chunk.next) || chunk.next <= offset) throw Error('Image response invalid');
        if (type && type !== chunk.mimeType) throw Error('Image response inconsistent');
        type = chunk.mimeType; size = chunk.size;
        if (!Number.isSafeInteger(size) || size > MAX_IMAGE_BYTES) throw Error('Image too large');
        parts.push(chunk.data); offset = chunk.next;
        if (chunk.done) {
          const bytes = decode(parts);
          if (bytes.length !== size) throw Error('Image incomplete');
          const url = createUrl(new Blob([bytes], { type }));
          remember(key, url); return url;
        }
      }
      throw Error('Image too fragmented');
    })();
    loading.set(key, work);
    try { return await work; } finally { loading.delete(key); }
  }
  const cached = (scope, messageId, index) => urls.get(keyOf(scope, messageId, index));
  const clear = () => { for (const url of urls.values()) revokeUrl(url); urls.clear(); };
  return { load, cached, clear, get size() { return urls.size; } };
}
/** Fills `[data-image-slot]` placeholders of one rendered message row. */
export function hydrateImages(row, loader, scope) {
  for (const slot of row.querySelectorAll('[data-image-slot]')) {
    const messageId = slot.dataset.messageId, index = Number(slot.dataset.imageIndex);
    const trigger = slot.querySelector('button');
    const show = url => {
      const image = document.createElement('img');
      image.className = 'tui-image-pic'; image.alt = `Image ${index + 1} of this message`; image.loading = 'lazy'; image.decoding = 'async'; image.src = url;
      // An evicted (revoked) blob must not leave a broken picture: offer the load control again.
      image.addEventListener('error', () => { if (trigger) { trigger.disabled = false; trigger.textContent = 'Image released · show again'; slot.replaceChildren(trigger); } });
      slot.replaceChildren(image);
    };
    trigger?.addEventListener('click', async () => {
      trigger.disabled = true; trigger.textContent = 'Loading image…';
      try { show(await loader.load(scope, messageId, index)); }
      catch { trigger.disabled = false; trigger.textContent = 'Image unavailable · retry'; }
    });
    const cached = loader.cached(scope, messageId, index);
    if (cached) show(cached);
  }
}
