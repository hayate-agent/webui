# Register an agent

Open **Agents** in the navigation. The main area lists registered agents with
identity, endpoint, granted capabilities and the time of the last connection check.
The local agent is the dashboard's existing backend, not a separately registered peer.

## Add a Hayate agent

1. On the target agent, run `/agent-hub pair`.
2. Copy the HTTPS endpoint and five-minute, single-use code it returns.
3. In the dashboard choose **Register an agent**.
4. Enter a name, endpoint and code; optionally choose a six-digit color.
5. Choose **Connect agent**, then **Check connection**.

The target needs AgentLink's HTTPS endpoint enabled, a trusted certificate and an
explicit sharing policy. Its browser-login password is not a registration code.
A target without an enabled endpoint cannot generate a usable pairing response.

Registration codes are cleared from the form after submission and are not stored
in browser storage. The resulting peer token stays in the backend vault. If a
request's outcome is uncertain, check the agent list before obtaining a new code;
registration is not automatically retried. An existing endpoint cannot be added twice.

## Manage access

- **Check connection** performs a read-only request. It does not start agent work.
- **Edit name and color** changes presentation, not endpoint, target identity or permissions.
- **Remove agent** revokes target authorization before removing the local registration.
  An unavailable target leaves the registration in place for an explicit retry.

Registration makes an agent available for selection. It is distinct from project
membership and does not automatically expose files or distribute Git credentials.
Removing a connection does not cancel already accepted work or erase target history.

The API advertises management features. Older backends retain basic pairing and
read-only connection checks; editing is shown only where the API supports it.

## Integration test

Build the dashboard and provide an external Plugins checkout containing its API:

```sh
npm run build
HAYATE_PLUGINS_ROOT=/path/to/plugins node test/registration.integration.mjs
```

The test uses the actual API plugin, backend vault and two-instance TLS transport.
It verifies pairing, connection checks, editing, duplicate prevention, failed
revocation recovery and removal of actual target authorization. No credentials
or live deployment configuration are required.
