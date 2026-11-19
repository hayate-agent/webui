// Read-only refresh scheduling. Never accepts a send/mutation callback.
export function createRefreshHealth({ now = Date.now, random = Math.random } = {}) {
  let key, failures = 0, next = 0;
  const select = target => { if (key !== target) { key = target; failures = 0; next = 0; } };
  return {
    ready(target) { select(target); return now() >= next; },
    success(target) { select(target); failures = 0; next = 0; },
    failure(target) {
      select(target); failures++;
      const delay = Math.min(60000, Math.round(5000 * 2 ** Math.min(failures - 1, 4) * (0.8 + random() * 0.4)));
      next = now() + delay;
      return { failures, delay };
    },
  };
}
