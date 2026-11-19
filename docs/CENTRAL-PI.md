# PI live control in the existing central dashboard

The local daemon is the execution bridge. The central dashboard remains the primary UI. No remote listener is enabled on the local PI service.

## Transport

The adapter opens an outbound WSS channel using the existing Hayate AgentLink protocol. Central login, owner-scoped AgentHub records, single-use enrollment invitations and explicit central approval remain authoritative. No central backend API changes are required: PI hosts advertise `pi-live-v1` via the scoped projects query and transport explicitly allowlisted PI calls through the messages capability. An ordinary Hayate peer is not treated as PI.

The central dashboard bundle must include this checkout's `dashboard/public/app.js` and `pi-client.js` (via the normal build). Existing deployed images do not acquire these changes just because the local service is upgraded.

## Pair this host

1. In the existing central dashboard Agents management, create an outbound invitation named for this PI host.
2. Add to `~/.pi/webui.json`:

```json
"relay": {
  "endpoint": "https://hayate.example.com",
  "stateFile": "/Users/example/.pi/webui-relay.json"
}
```

3. Run `npm run pi:pair` once and supply the invitation interactively. Enrollment is explicit, not an autostart/manual-server requirement. The private enrollment file is created exclusively with mode 0600; it is not a repository file. A lost local enrollment after central acceptance needs central revocation/reconciliation, not blind re-enrollment.
4. Approve the pending host in the central dashboard.
5. Restart the local user service once (`npm run service -- restart`). Subsequent login starts reconnect automatically. Revocation/authorization failure stops reconnect attempts. Productive work is never automatically retried.

The updated central UI shows **PI · host name**, supports create/send/steer/follow-up/stop and RPC question answers using the existing authenticated API. Live snapshots are refreshed every 1.5 seconds while visible (not an SSE stream through the rendezvous). Transient text is bounded to 100,000 characters; relay results are bounded to 230 KB. Very large histories are not supported by this path yet.

## Native terminals

The installed global shim `~/.pi/agent/extensions/hayate-webui.js` loads the thin connector. Connector reads `~/.pi/webui.json` and defaults to `~/.pi/webui-runtime`. New TUI processes register automatically. Already running processes require `/reload`; a separate process cannot silently inject code into them. The shim points to this checkout, which must remain available.

Unowned disk history is still read-only, not an active session. Never resume it by a second writer merely to remove the read-only label. Native TUI-only questions remain terminal-owned; RPC questions are remotely answerable.

## Verification

`npm run build && npm test`

`PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" npm run test:central-browser`

Central-browser test disables the local `/api/pi` proxy entirely and drives create/send/live-text/stop/dialog actions via central AgentHub-shaped requests. Separate relay tests validate route scope, cookie isolation and duplicate rejection. These fixture tests do not claim a production enrollment or central deployment has occurred.
