// Files remain in browser memory; no localStorage/sessionStorage media copies.
export function createMediaDrafts({ maxBytes = 5 * 1024 * 1024, maxCount = 4 } = {}) {
 const drafts = new Map();
 const list = key => drafts.get(key) ?? [];
 return {
  list,
  add(key, files) {
   const previous = list(key), incoming = [...files];
   if (previous.length + incoming.length > maxCount) throw Error('At most four images per message');
   if (incoming.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) throw Error('Supported images: PNG, JPEG, WebP');
   if ([...previous.map(item => item.file), ...incoming].reduce((sum, file) => sum + file.size, 0) > maxBytes) throw Error('Combined images must not exceed 5 MiB');
   const added = incoming.map(file => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
   drafts.set(key, [...previous, ...added]); return list(key);
  },
  remove(key, id) {
   const items = list(key); const item = items.find(item => item.id === id);
   if (item) URL.revokeObjectURL(item.url);
   drafts.set(key, items.filter(item => item.id !== id));
  },
  clear(key) { for (const item of list(key)) URL.revokeObjectURL(item.url); drafts.delete(key); },
  destroy() { for (const key of drafts.keys()) this.clear(key); },
 };
}

/** `onProgress(fraction)` is called with 0 before the first chunk and after every acknowledged chunk (1 at the end). */
export async function uploadImageChunks(file, sendChunk, onProgress = () => {}) {
 const uploadId = crypto.randomUUID();
 const bytes = new Uint8Array(await file.arrayBuffer());
 if (!bytes.length) throw Error('Empty image');
 let result; onProgress(0);
 for (let offset = 0, index = 0; offset < bytes.length; offset += 45000, index++) {
  const part = bytes.subarray(offset, offset + 45000);
  let binary = ''; for (const byte of part) binary += String.fromCharCode(byte);
  result = await sendChunk({ uploadId, index, data: btoa(binary), mimeType: file.type, final: offset + part.length === bytes.length });
  onProgress((offset + part.length) / bytes.length);
 }
 if (!result?.id || !result?.sha256) throw Error('Image upload did not complete');
 return { id: result.id, sha256: result.sha256, size: result.size, name: file.name };
}
