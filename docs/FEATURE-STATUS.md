# Dashboard capabilities

## Conversations and projects

- Conversations retain their agent-owned history and execution context.
- Projects group conversations and apply shared model, reasoning and instruction settings.
- Moving a conversation between projects does not change its execution directory.
- Archive and delete actions hide entries without deleting retained agent history.
- Completion indicators use durable completion/read markers.

## Agent connections

AgentLink and AgentHub provide registration, expiring pairing codes, scoped access
and revocation. The dashboard uses their API; it does not store peer tokens in the
browser. Target administrators control shared projects and local directories.

Remote conversations refresh through bounded API reads. Productive requests are
sent only by explicit user action. Retry identities are retained for unconfirmed
messages and stream creation.

## Authentication

Login and account changes use the identity backend. Changing the login name or
password requires the current password and revokes existing sessions. Session
cookies are Secure, HttpOnly and SameSite-restricted. With a compatible identity
backend, trusted keyboard, pointer, wheel and input/editing interaction in the
visible page renews the idle session and its cookie at most once a minute.
Interaction suppressed by that throttle is coalesced into one trailing renewal,
so the last interaction retains the full inactivity interval. This is not a
periodic keepalive; logout cancels pending activity and hidden pages do not flush it. Polling and SSE do not renew idle sessions. Session
hashes survive backend restarts; upgrading an older memory-only backend requires
one fresh login. Idle expiry, logout and account-change revocation remain active.
The renewal endpoint requires the corresponding Plugins session-continuity update;
older backends keep their existing expiry behavior. Account changes do not change
ownership of projects or credentials.

## Integration requirements

- Projects require the workspace service.
- Remote agents require AgentHub and a compatible AgentLink adapter.
- Repository discovery requires a configured Git catalog provider and local checkout mappings.
- Secret storage uses configured backend providers; secret values are write-only in the UI.
- Network access requires HTTPS and a configured identity backend.

See [project boundaries](BOUNDARIES.md) and the [installation guide](../README.md).
