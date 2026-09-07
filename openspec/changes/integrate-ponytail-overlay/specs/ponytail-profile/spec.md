## ADDED Requirements

### Requirement: Opt-in pinned Ponytail skills
Cue SHALL expose a `ponytail` overlay inheriting `core` for Claude Code and Codex,
with the six upstream skills resolved at an explicit full Git revision.

#### Scenario: Standalone activation
- **WHEN** a user selects `ponytail`
- **THEN** Cue SHALL make `ponytail`, `ponytail-review`, `ponytail-audit`,
  `ponytail-debt`, `ponytail-gain`, and `ponytail-help` available
- **AND** resolution SHALL NOT require a machine-specific upstream checkout

#### Scenario: Composition preserves the base profile
- **WHEN** a user composes a domain profile with `ponytail`
- **THEN** the base profile's skills SHALL remain available alongside Ponytail

### Requirement: Skills-only integration
The overlay SHALL NOT add plugins, lifecycle hooks, MCP servers, or global agent
configuration beyond the selected base profile's existing configuration.

#### Scenario: Existing profiles remain unchanged
- **WHEN** a user does not select the Ponytail overlay
- **THEN** the user's selected profile and default profile SHALL remain unchanged

#### Scenario: Reviews require a request
- **WHEN** the overlay is selected for an ordinary coding task
- **THEN** its persona SHALL NOT require unrequested review, audit, or debt tasks
