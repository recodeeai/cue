## ADDED Requirements

### Requirement: Codex uses Ponytail by default
Every Cue-managed Codex launch SHALL include the Ponytail profile's upstream
skills and coding guidance without requiring an explicit `+ponytail` selector.

#### Scenario: Any selected profile
- **WHEN** Codex launches with a selected profile, including a composite
- **THEN** the runtime SHALL contain the six Ponytail skills and its coding guidance
- **AND** the original profile name, runtime key, settings and persona SHALL be preserved

#### Scenario: Workspace persona and skill pruning
- **WHEN** a workspace overrides the persona or launch skill filtering is active
- **THEN** Ponytail guidance and its remote skills SHALL still be included

#### Scenario: Explicit Ponytail selection
- **WHEN** a selected profile already contains Ponytail
- **THEN** defaults SHALL NOT duplicate its skills or guidance
- **AND** an existing Codex-eligible upstream pin SHALL be preserved

### Requirement: Other agent and user controls remain intact
Default activation SHALL be limited to Cue-managed Codex sessions and SHALL NOT
install lifecycle hooks or modify the user's profile pin or global agent settings.

#### Scenario: Claude launch
- **WHEN** Claude launches without explicitly selecting Ponytail
- **THEN** Ponytail SHALL NOT be added by the Codex default

#### Scenario: Conversation override
- **WHEN** the user requests Ponytail lite, full, ultra or off in the conversation
- **THEN** the default guidance SHALL instruct the agent to honor that request
