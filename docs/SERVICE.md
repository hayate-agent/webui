# PI WebUI user service (macOS)

The supported persistent entrypoint is a launchd login service, configured in `~/.pi/webui.json`. No shell environment is needed after installation. It starts at login and restarts after process exit. It is a user service, not a pre-login system daemon.

Create `~/.pi/webui.json` (replace the Hayate URL with your existing backend):

```json
{
  "version": 1,
  "hayateUrl": "https://YOUR-EXISTING-HAYATE-API",
  "port": 3210,
  "adapterPort": 3211,
  "roots": ["/Users/example/Work/Development"],
  "sessionRoots": ["/Users/example/.pi/agent/sessions"],
  "piExecutable": "/opt/homebrew/bin/pi"
}
```

Additional optional settings: `bridgeDir` (default `~/.pi/webui-runtime`), `hayateOrigin`, `tlsName`, `caFile` (absolute PEM path). All filesystem settings must be absolute, not `~` strings. Unknown keys are rejected. Do not store secrets or embed credentials in URLs.

From this checkout:

```sh
npm run build
npm run service -- check
npm run service -- install
npm run service -- status
```

Installation registers `~/Library/LaunchAgents/net.hayate.pi-webui.plist` and starts it immediately. Existing definitions are never overwritten implicitly. A custom config path can be passed as the next argument to each command. The service reads config at each start; `npm run service -- restart` sends SIGTERM for orderly shutdown and launchd restarts it. `stop` disables it until `start` or the next login; `uninstall` removes the service definition, not your config/history. Do not run a manual adapter on the same socket/ports alongside the service.

Browser: `http://127.0.0.1:3210`. Adapter/console: `http://127.0.0.1:3211`. Logs: `~/.pi/webui-logs/stdout.log` and `stderr.log`. Status is launchd status, not an assertion that Hayate is reachable: verify the browser and logs after install. Invalid configuration exits visibly; launchd retry is throttled to 15 seconds.

Terminal connector currently still loads opt-in with `pi -e /absolute/checkout/pi-adapter/extension.mjs` and `PI_WEBUI_BRIDGE_DIR` set to the configured bridge directory. The service does not silently install extensions or modify running native sessions. See LOCAL-START.md for console interactions and remaining product limitations. Keep the checkout at its installed location until uninstalling/reinstalling; the plist uses absolute paths.
