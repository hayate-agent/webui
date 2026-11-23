// Loads the dashboard bundle on first use. app.js stays small; a failed load can be retried.
let pending;
export function loadDashboard(importer = () => import('/dashboard.js')) {
  pending ??= Promise.resolve().then(importer).catch(error => { pending = undefined; throw error; });
  return pending;
}
export function resetDashboardLoader() { pending = undefined; }
