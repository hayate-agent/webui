# Agents behind NAT: outbound WebSocket

With the outbound AgentLink plugins enabled, an agent can connect to the central
dashboard's normal HTTPS address and keep a WSS channel open. The target needs no
public API listener or port forwarding. Requests and replies travel over that one
agent-originated channel.

## Connect manually

1. On the central dashboard, open **Agents → Invite outbound agent**.
2. Choose a display name. The invitation code is masked, single-use and expires
   after five minutes. Copy it only to the target's enrollment form or command.
3. On the target, choose **Agents → Connect this agent outbound** and enter the
   central HTTPS origin and invitation. An administrator may instead run
   `/agent-link-outbound enroll <HTTPS-origin> <invitation-code>`.
4. Return centrally to **Incoming connections**. Inspect the target identity and
   granted capabilities, then choose **Approve and register**.

Opening a socket does not automatically register an agent. Existing target-local
project authorization remains in force; the invitation cannot expand it.

## Prerequisites

- Central backend: credentials, workspace, AgentLink relay and AgentHub with the
  `hayate-wss` adapter, plus authenticated native-TLS dashboard API.
- Target: credentials, workspace and the AgentLink outbound plugin; an explicit
  relay allowlist and capability/project policy.
- Independent WebUI release with fixed-path WSS forwarding to its verified HTTPS
  API upstream. There is no arbitrary tunnel or browser-selected proxy destination.

Backend installation examples are in the Plugins project's
`docs/agent-link-websocket.md`. This page does not imply that merely updating the
frontend enables unconfigured backend plugins.

## Interrupted connections

The target reconnects its channel with bounded backoff. It does **not** replay a
productive request. Lost replies are displayed as unknown outcomes; reconcile or
retry explicitly using the original message identity. Already accepted work may
continue after a waiting client disconnects.

Removing a registered WSS agent revokes its relay authorization and closes the
connection. It does not erase history or cancel already accepted work. Permanent
authorization stays in backend vaults, not browser storage or invitation URLs.

Direct HTTPS/Tailscale registration remains available independently. Transport
selection is explicit; automatic direct-to-WSS productive fallback is not enabled.
