# Local PI adapter (work in progress)

This checkout contains an opt-in local adapter alongside the existing Hayate backend, not a replacement for Hayate. **It is not yet a complete implementation of the requested unified experience.**

## Implemented boundaries

- `pi-adapter/owner-server.mjs`: dedicated private Unix socket daemon; registers existing session owners, correlates commands and emits live events. Duplicate connected session IDs rejected. Socket is never unlinked to take over another daemon.
- `pi-adapter/extension.mjs`: thin opt-in PI TUI connector; no HTTP server or second agent runtime in PI. Snapshot/prompt/steer/follow-up/abort; live lifecycle/message/tool events. Slash commands deliberately rejected until explicit mappings exist.
- `pi-adapter/rpc-owner.mjs`: new native PI RPC worker, native persistence, correlated commands and streamed events.
- `pi-adapter/service.mjs`: loopback HTTP/SSE adapter, explicit realpath workspace roots for creation, maximum eight active/pending RPC workers. Also supports an opt-in read-only disk catalog via newline-separated `PI_WEBUI_SESSION_ROOTS`; uses opaque IDs, bounded caching (8 MiB/file, 16 MiB aggregate input budget per coalesced scan) and excludes symlinks, with no native migration/write on read.
- `pi-adapter/console.mjs`: terminal attach to the existing owner, including browser-created RPC sessions. This is a text client, **not the full native PI TUI**. It does not resume the active file in another PI process.
- Fixed `/api/pi/*` routing in the WebUI server. Enabled PI routing is loopback-only; network dashboard configuration is rejected because a shared authorization service is not yet implemented. Hayate cookies are not forwarded to PI.
- Local PI list and conversation panel appear beside the existing Hayate UI after Hayate authentication.

## Development startup (explicit opt-in only)

No global config changes or automatic installs are performed. Choose a fresh private directory and allowed workspace roots:

```sh
export PI_WEBUI_BRIDGE_DIR="$HOME/.local/state/pi-webui"
export PI_WEBUI_ROOTS="$HOME/Work/Development"
node pi-adapter/main.mjs
```

Daemon defaults to `127.0.0.1:3211`. It intentionally refuses a pre-existing socket; after a crash, investigate ownership before manually removing stale state.

In a terminal PI process (requires a PI version exposing `ctx.mode`, `getBranch`, `getLeafId` and `agent_settled`, verified against installed 1.5.2):

```sh
PI_WEBUI_BRIDGE_DIR="$HOME/.local/state/pi-webui" pi -e /absolute/path/to/webui/pi-adapter/extension.mjs
```

For the dashboard, retain the existing Hayate URL and add the fixed PI adapter URL:

```sh
npm ci
npm run build
HAYATE_AGENT_URL=https://existing-hayate-api.example \
PI_WEBUI_ADAPTER_URL=http://127.0.0.1:3211 \
HAYATE_DASHBOARD_ORIGIN=http://127.0.0.1:3210 npm start
```

Console access to registered sessions:

```sh
node pi-adapter/console.mjs list
node pi-adapter/console.mjs SESSION_ID
```

`/stop`, `/steer TEXT`, `/followup TEXT`, `/quit` are console-client commands. Productive requests are not automatically retried after uncertainty.

## Security and functional limits — do not mistake for completion

- Local same-OS-user agent control; not safe for untrusted local users/processes. No network PI exposure.
- TUI owners are opt-in via private directory; root allowlist currently constrains RPC creation, not registered TUI cwd.
- Duplicate socket owners rejected, but an independent PI process not loading this connector can still resume files. There is **no system-wide PI writer lock** yet. An idle persisted adapter-owned RPC session can explicitly be released: the adapter waits for process exit, then returns native `--session` arguments. This does not prevent unrelated unmodified PI processes opening the file independently.
- Full native TUI attachment to a running RPC owner is not implemented. The console text client is a separate supported presentation path.
- Inactive-session read-only catalog is implemented; safe inactive resume/global writer coordination, native version negotiation, rich tool rendering and model selection remain outstanding.
- RPC select/confirm/input/editor dialogs now accept browser responses, with first-answer-wins validation and timeout checks. Console RPC-dialog answers use `/answer ID VALUE` (yes/no for confirm, option number for select) and `/cancel ID`. TUI browser dialog arbitration remains outstanding; TUI questions must still be answered in their owning native terminal.
- Prompt acceptance is not a durable Hayate queue or exactly-once guarantee. UI currently reports uncertainty instead of automatically resending.
- Active branch transcript is projected from parent links; underlying storage stays native PI. No migration/import of user sessions.
- Real-browser fixture integration now covers Hayate remaining available alongside PI creation, transcript, prompt, live streaming and stop. A real isolated native TUI/PTY test now verifies registration, prompt submission, streamed response and persisted assistant history using an exclusively loopback test provider, plus snapshot, rename and abort. The opt-in `PI_WEBUI_BROWSER_NATIVE_TEST=1` now covers real Chromium → dashboard → adapter → actual PI TUI → local fixture provider → browser response. Browser dialog tests cover input, decline and draft retention. Further fault-path hardening and TUI dialog arbitration remain required.
- RPC shutdown now waits for actual child exit. Timeout explicitly retains ownership and reports failure instead of claiming successful shutdown.

## Tests executed

`npm run build`; `npm test`; `PI_WEBUI_NATIVE_TEST=1 node --test test/pi-native.test.mjs` (offline, isolated PI agent home and session root, no model requests). Socket and connector tests use actual Unix IPC with mocked PI API; console test uses actual HTTP/SSE with a fake owner; native RPC test starts installed PI. Run the full native browser path with `PI_WEBUI_NATIVE_TEST=1 PI_WEBUI_BROWSER_NATIVE_TEST=1 PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" node --test test/pi-tui-native.test.mjs`. The native RPC test also persists a conversation using a loopback fixture, waits for process exit and reopens the same session ID/history in a second real PI RPC process. This proves persistence/reopen, not native TUI ownership locking or the complete HTTP-release-to-TUI path.
