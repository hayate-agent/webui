# Project boundaries

## Backend plugins

These components belong to the Plugins repository and are usable without a browser:

- **AgentLink:** agent endpoint, transport, target authorization and access-token scope.
- **AgentHub:** pairing, registration metadata and credential references.
- **Workspace:** projects, session/context bindings and completion/read state.
- **Credentials:** vault implementations and provider access.
- **Identity:** password verifiers, account changes and authentication sessions.

## WebUI

This repository owns:

- Browser navigation, conversation rendering, menus, forms and agent selection.
- Static asset build and browser dependencies.
- The standalone HTTP/TLS presentation server and its configured API connection.
- Dashboard CI, container image and deployment.

The dashboard communicates with backend plugins through their API. It does not
import Core or plugin implementations, execute models or maintain another copy of
agent histories. Compatibility depends on API versions and supported capabilities,
not matching Git revisions.

## Authentication boundary

The presentation server validates browser Host/Origin before mapping requests to
the configured backend origin. Cookies stay HttpOnly. Password verification and
peer-token custody remain with the backend. There is no arbitrary upstream URL,
forwarded-user trust or automatic retry of productive requests.

## Deployment boundary

Dashboard releases are built and deployed independently from agent releases. A
frontend update does not require rebuilding Core. Backend data and credentials
remain in their existing agent-owned storage. Deployment changes must preserve
that storage and verify authentication, API compatibility and event delivery.
