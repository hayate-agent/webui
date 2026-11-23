// Server-owned switch for the tools generated dashboards may call (see docs/DASHBOARD-TOOLS.md).
// The server is the only place that decides; the browser just reads the result, so neither a
// dashboard definition nor a model can loosen it. An unknown value NEVER loosens anything.
// (The browser module dashboard/public/dashboard-tools.js repeats this normalisation on purpose:
// the runtime image ships only dist/ and server/, and a test keeps both in agreement.)
export const DASHBOARD_TOOL_MODES = ['strict', 'off', 'open'];
export const DEFAULT_DASHBOARD_TOOL_MODE = 'strict';

export function dashboardToolMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DASHBOARD_TOOL_MODES.includes(mode) ? mode : DEFAULT_DASHBOARD_TOOL_MODE;
}

/** Reads the switch from the environment. Returns the effective mode plus a warning for the log. */
export function dashboardToolsFromEnvironment(environment = process.env) {
  const raw = environment.HAYATE_DASHBOARD_TOOLS;
  const mode = dashboardToolMode(raw);
  const given = typeof raw === 'string' && raw.trim() !== '';
  const warning = given && mode !== raw.trim().toLowerCase() ? `HAYATE_DASHBOARD_TOOLS has an unknown value; using "${DEFAULT_DASHBOARD_TOOL_MODE}"` : undefined;
  return { mode, warning };
}
