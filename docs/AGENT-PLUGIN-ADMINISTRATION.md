# Agent-specific plugin administration

## Existing activation contracts

A plugin repository is source code, not an activation list. A file being present
in a repository or installed overlay does not automatically enable it on agents.

The agent's configuration owner controls:

- `plugins`: trusted startup modules, loaded from explicit local paths.
- `reloadableToolPlugins`: explicit tool-only modules eligible for controlled reload.
- `gatewayPlugins`: selected gateway implementations and their activation.
- `tools`: tool allowlist; installing a plugin does not override it.
- Built-in product features: their existing feature settings remain authoritative.

Startup modules require a restart through the host's update-admission lifecycle.
General startup-plugin hot reload is not supported. Tool-only modules have a
separate, limited reload contract. Trusted ESM plugins execute with the agent
process's permissions; this is not a sandbox.

## Required repository-management workflow

Agent administration needs to distinguish these states:

1. Repository configured, with credential reference and synchronization interval.
2. Catalog fetched and validated without executing repository code.
3. A specific version installed and its artifact integrity verified.
4. Plugin selected and configured in this agent's desired overlay.
5. Running instance activated by its configuration/runtime owner.

Periodic synchronization refreshes the catalog and reports available versions.
It must not automatically enable newly discovered plugins or silently replace a
running module. Desired and observed runtime state must be shown separately,
including pending admission, unsupported ownership and failed activation.

The management backend belongs to Plugins. Config files/overlays are the durable
source of desired state. Terminal UI, administrator slash commands, messaging
interfaces and standalone/combined web administration should call the same service
rather than maintaining independent plugin lists.

Repository registration, scheduled catalog synchronization and general plugin
activation controls are not yet implemented. Their UI must not imply that a
checkbox changed an active runtime when only configuration was saved.

## Access and deactivation

- Repository URLs must not contain credentials. Store references to backend-vault entries.
- Use reviewed immutable revisions/artifacts, not arbitrary chat-provided code.
- Validate API compatibility and dependencies before preparing activation.
- Do not deactivate a dependency while active dependants still require it.
- Fence new work, obtain fresh admission and drain accepted work before replacing
  a startup module. Busy is pending, not permission to force a restart.
- Deactivation does not delete plugin-owned histories, credentials or project data.
