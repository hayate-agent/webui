# Hayate WebUI

Independent web dashboard and presentation gateway for Hayate agents. This is a
separate project: no Core imports, agent runtime, project store, vault or model
execution is embedded here. The existing agent API remains authoritative for
identity, workspaces, credentials, pairing and durable message acceptance.

## Run locally

Requires Node >=22.19:

```sh
npm ci
npm run build
HAYATE_AGENT_URL=https://agent.example.org \
HAYATE_DASHBOARD_ORIGIN=http://127.0.0.1:3210 npm start
```

The gateway validates the browser against the dashboard's canonical Host/Origin,
then forwards to the configured agent API's canonical Host/Origin. Only `/api/*`
is forwarded, without browser-selected upstreams, redirect following, forwarded-user
trust or TLS bypass. Authentication uses the backend's HttpOnly session cookies.

For network use set `HAYATE_DASHBOARD_HOST`, `HAYATE_DASHBOARD_ORIGIN` (HTTPS),
`HAYATE_TLS_KEY_FILE` and `HAYATE_TLS_CERT_FILE`. For an internal backend connection
with a public certificate set `HAYATE_AGENT_TLS_NAME` and `HAYATE_AGENT_ORIGIN`
to that API's canonical HTTPS origin. The upstream connection URL may be an
internal service address, but its certificate remains verified against the
configured canonical name. No identity or access-token logic is copied here. No permissive CORS or remote HTTP.

## Tests and deployment

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

`Dockerfile` builds and runs only this dashboard. GitHub CI tests builds, HTTP
security and the browser independently of Core. Tagged releases publish
`ghcr.io/hayate-agent/webui:<tag>` plus the operator-selectable `stable` channel;
`compose.yaml` shows explicit TLS/backend configuration. It is published and deployed
independently from Core and backend plugins; an agent does not require a new Core
image just to receive a frontend fix. Dependency lockfiles make builds reproducible;
this does not require each agent to pin a matching dashboard revision.

The frontend checks API/service capabilities. Backend state, approvals and history
remain with their owning agent. A disconnected or incompatible API must fail
explicitly; productive requests are never automatically retried.

## Backend plugins

AgentLink, AgentHub, workspace, identity and credentials are installed on the
agent from the Plugins project. This dashboard references their APIs rather than
bundling their implementations. See [project boundaries](docs/BOUNDARIES.md).
