# PI adapter review evidence

2026-11-17, local installed `@earendil-works/pi-coding-agent` 1.5.2.

Initial review identified `ctx.mode` and `get_entries` as unsupported. Both claims are false for the explicitly targeted installed PI version:

- `dist/core/extensions/types.d.ts` declares `mode: ExtensionMode` (line 237 at inspection); `docs/extensions.md` documents `ctx.mode`.
- `dist/modes/rpc/rpc-mode.js` handles `get_entries` and returns `{ entries, leafId }` (lines 525–535 at inspection); `docs/rpc-commands.md` documents it.
- `PI_WEBUI_NATIVE_TEST=1 node --test test/pi-native.test.mjs` starts the actual installed offline PI executable using isolated agent/session directories and confirms get_state/get_entries. No model calls or user-session access.

Do not remove these APIs based on assumptions about older PI releases. Version negotiation and a real native TUI acceptance test are still outstanding.

Valid findings fixed:

- Active plus pending RPC creation reservations enforce worker capacity during asynchronous startup.
- Owner command boundary reserves busy on prompt submission, refusing mode-less concurrent RPC prompts; explicit steer/followUp preserved. Native RPC also rejects ambiguous busy prompting.
- Unix owner daemon, connector and RPC parser reject non-object/null/array records rather than dereferencing them.

Current verification: build successful, 22 default tests passed, 1 opt-in test skipped in default suite; opt-in native test separately passed. End-to-end browser, live real TUI, shared dialog arbitration and inactive-session catalog remain unverified/incomplete. This is work in progress, not a full product PASS.
