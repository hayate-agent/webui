# Local unified Hayate + PI WebUI

## Start both presentation services with one command

From this checkout:

```sh
npm ci --ignore-scripts
npm run build
HAYATE_AGENT_URL=https://YOUR-EXISTING-HAYATE-API \
PI_WEBUI_ROOTS="$HOME/Work/Development" \
npm run start:local
```

The placeholder backend URL must be replaced with your actual existing API. The launcher prints the browser URL (default `http://127.0.0.1:3210`), dynamically selected local PI endpoint and connector directory. It does not install extensions globally or change existing sessions. Ctrl+C closes the dashboard and requests orderly PI worker shutdown, waiting for actual exit; shutdown timeout is an error, not an ownership release.

Optional variables:

- `HAYATE_DASHBOARD_PORT`: local browser port, default 3210.
- `PI_WEBUI_BRIDGE_DIR`: private same-user Unix socket directory, default `~/.local/state/pi-webui`.
- `PI_WEBUI_ROOTS`: newline-separated allowed directories for new PI sessions.
- `PI_WEBUI_SESSION_ROOTS`: newline-separated session directories for read-only historical discovery. To include standard local PI history, explicitly set it to `$HOME/.pi/agent/sessions`.
- `HAYATE_AGENT_ORIGIN`, `HAYATE_AGENT_TLS_NAME`, `HAYATE_AGENT_CA_FILE`: existing canonical backend TLS/proxy configuration.

## Connect a native terminal PI

Use the exact connector directory and absolute extension path printed by the launcher:

```sh
PI_WEBUI_BRIDGE_DIR="$HOME/.local/state/pi-webui" \
pi -e /absolute/path/to/this/checkout/pi-adapter/extension.mjs
```

The terminal session then appears under **Local PI** beside Hayate in the same browser. To continue an existing session, add `--session SESSION_FILE` only after ensuring it is not already owned by another process. Existing running terminals must load the connector through their normal extension configuration/reload mechanism before they can attach; the launcher cannot retrofit an unmodified process.

## Work from console in a browser-created session

Use the PI endpoint printed by the launcher:

```sh
PI_WEBUI_ADAPTER_URL=http://127.0.0.1:PRINTED_PORT npm run pi:console -- list
PI_WEBUI_ADAPTER_URL=http://127.0.0.1:PRINTED_PORT npm run pi:console -- SESSION_ID
```

This attaches to the same live owner, not another runtime. Commands: `/stop`, `/steer TEXT`, `/followup TEXT`, `/answer ID VALUE`, `/cancel ID`, `/quit`.

To resume in the native PI TUI instead, use **Release RPC to native console** on an idle persisted session. The old process must actually exit before the UI returns structured `--session` arguments. This is a manual handoff, not a systemwide file lock.

## Delivered and remaining boundaries

Working and tested: unified fixed routing, live native TUI text prompt/streaming, new RPC conversations, native persistence/reopen, console text attach, RPC question answers in browser/console, read-only historical catalog, same-origin loopback checks and orderly shutdown.

Not complete: browser answers to native TUI-only dialogs, global protection against independent PI writers, native TUI acting as live RPC client, complete large-history pagination (catalog is deliberately bounded), model-management UI. Native custom terminal components are not rendered in browser. This local build is not a network/multiuser deployment.

The current independent-review prefilter is blocked by a false positive on an existing authorization-variable forwarding expression; this is not a claim of a current final review PASS. No commit, push, deployment or global activation is implied by this document.
