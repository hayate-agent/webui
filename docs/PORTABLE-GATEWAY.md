# Deploy the PI gateway on another host

## Components

The gateway is **not only a PI extension**. `pi-adapter/extension.mjs` is the thin connector loaded inside native PI. `scripts/webui-service.mjs run` starts the loopback adapter, local dashboard and optional authenticated outbound AgentLink relay. The central dashboard does not open an inbound port on the PI host. Each host needs its own enrollment; never copy another host's relay state or token.

Supported managed services: macOS launchd and Linux user systemd. The adapter uses Unix domain sockets; Windows is not supported. Linux service generation is unit tested; live Linux lifecycle acceptance must be performed on the target host. macOS launchd is the existing production path.

## Reproducible checkout installation

Install Node >=22.19.0, npm, and PI on the target host. Clone this repository to a stable location (not a temporary worktree), select a reviewed revision and run:

```sh
npm ci --ignore-scripts
npm run build
npm run pi:install-connector
```

The connector command creates a self-contained `~/.pi/agent/extensions/hayate-webui.js` bundle mode0600 from **that host's checkout**, not a developer machine. Native `.mjs` imports can remain cached across PI reloads, so the installed entry deliberately contains the connector and history pager together. It refuses to overwrite an existing connector. Keep the checkout in place while the service/extension is installed. To relocate: run `npm run service -- uninstall` from the old checkout before moving it (both generated service definitions reference the original checkout), inspect/remove the old generated shim yourself, then reinstall the connector AND run `npm run service -- install` from the new checkout and reload PI. Do not load this extension twice via both package configuration and discovery shim.

Create `~/.pi/webui.json` with private permissions (directory0700, file0600). All paths below must be replaced with target-host paths:

```json
{
  "version": 1,
  "hayateUrl": "http://127.0.0.1:18789",
  "roots": ["/absolute/workspace"],
  "sessionRoots": ["/absolute/home/.pi/agent/sessions"],
  "piExecutable": "/absolute/path/to/pi"
}
```

`hayateUrl` is the target host's reachable Hayate backend; it is not a credential URL. See LOCAL-START.md and SERVICE.md for TLS and central enrollment configuration. Consult the enrollment usage in `scripts/pi-relay-enroll.mjs` before running `npm run pi:pair`; do not pass unsupported flags. The service never generates or copies central credentials automatically.

```sh
npm run service -- check
npm run service -- install
npm run service -- status
```

After each source update/build, refresh the generated bundle with `npm run pi:install-connector -- --update`, then reload PI at a safe idle boundary. The update command accepts only a private, same-user generated bundle from this checkout; it rejects legacy/custom shims. For a legacy shim, inspect it, back it up outside the extension-discovery directory, and run the default installer. Do not leave two discoverable connector entries. A gateway restart does not replace code in an existing PI process. Verify `history-page-v1` in that native owner's features rather than treating a reload acknowledgement as successful activation.

Reload PI to discover the connector, then verify the session appears in the gateway. Existing sessions need the connector loaded before they can be controlled. Disk-only history stays read-only.

Linux: requires an active user systemd manager. To run after logout, an administrator must explicitly enable lingering for that user; the installer does not change login policy or request sudo. Use `journalctl --user -u net.hayate.pi-webui.service` for logs. If systemd is unavailable use `npm run service -- run` under an existing supervisor instead. Use absolute `piExecutable` because a user service does not inherit interactive shell initialization.

```sh
npm run service -- restart
npm run service -- stop
npm run service -- start
npm run service -- uninstall
```

Uninstall removes only the service definition, not histories, configuration, relay identity or connector. Remove the generated connector explicitly after inspection if retiring the integration. Do not delete PI session files.

## Verification and security

Run `npm test` and `npm run test:browser` before release. On each new platform verify service start/restart/logout behavior, session discovery, authenticated enrollment, send/stop, relay reconnect and single-owner history behavior. Loopback is not multi-user authentication; only the authenticated AgentLink is intended for remote access. Do not expose adapter3211 or dashboard3210 publicly, proxy arbitrary routes, or embed tokens in service definitions.
