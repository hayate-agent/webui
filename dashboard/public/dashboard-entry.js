// Entry of the lazily loaded dashboard bundle (dist/public/dashboard.js). It carries OpenUI, zod
// and its own React copy (~800 KiB), so app.js must never import it statically.
export { mountDashboard, DashboardView } from './ui/dashboard/view.jsx';
export { dashboardLibrary } from './ui/dashboard/library.jsx';
