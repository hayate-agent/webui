// Tool policy for generated dashboards (OpenUI `Query` / `Mutation`).
//
// A dashboard is written once by a model and then runs by itself in the browser: it re-runs its
// queries on a timer with the operator's session. Data a query returns (ticket text, mail
// subjects, ...) can contain instructions aimed at the model (prompt injection). Therefore the
// DEFAULT is strict. The mode is a deliberate switch, documented in docs/DASHBOARD-TOOLS.md:
//
//   strict (default)  reads only from the agent's allowlist; writes need an explicit confirmation
//                     by the operator, every single time; everything else is refused.
//   off               dashboards cannot call any tool (static layouts only).
//   open              every tool the agent offers runs without confirmation. Unsafe on purpose:
//                     only for a trusted single-user setup. The operator must choose it.
export const MODES = ['strict', 'off', 'open'];
export const DEFAULT_MODE = 'strict';

/** Unknown or missing values never loosen anything: they fall back to strict. */
export function normalizeMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export class ToolRefused extends Error {
  constructor(tool, reason) { super(`Dashboard tool "${tool}" refused: ${reason}`); this.name = 'ToolRefused'; this.tool = tool; this.reason = reason; }
}

/**
 * Builds the `toolProvider` function map for `<Renderer toolProvider=…>`.
 *  - mode:    'strict' | 'off' | 'open' (see above)
 *  - tools:   [{ name, kind: 'read' | 'write' }] the agent offers; the allowlist is what the agent
 *             marks as 'read'. A tool without a kind counts as 'write' (fail closed).
 *  - call:    async (name, args) => result   transport to the agent (owner/session bound elsewhere)
 *  - confirm: async ({ tool, args }) => boolean   asks the operator; only used for writes in strict
 *  - audit:   optional ({ tool, kind, outcome }) => void
 * Tool names the agent does not offer are not in the map at all, so the runtime reports
 * "tool not found" instead of calling anything.
 */
export function createToolProvider({ mode, tools = [], call, confirm, audit = () => {} }) {
  const effective = normalizeMode(mode);
  const provider = {};
  if (effective === 'off') return provider;
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || !tool.name) continue;
    const kind = tool.kind === 'read' ? 'read' : 'write';
    provider[tool.name] = async (args = {}) => {
      if (effective === 'strict' && kind === 'write') {
        let approved = false;
        try { approved = (await confirm?.({ tool: tool.name, args })) === true; } catch { approved = false; }
        if (!approved) { audit({ tool: tool.name, kind, outcome: 'declined' }); throw new ToolRefused(tool.name, 'the operator did not confirm this change'); }
      }
      try { const result = await call(tool.name, args); audit({ tool: tool.name, kind, outcome: 'ok' }); return result; }
      catch (error) { audit({ tool: tool.name, kind, outcome: 'error' }); throw error; }
    };
  }
  return provider;
}
