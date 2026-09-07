# Codex defaults to Ponytail

The user requested that every Cue-managed Codex launch use Ponytail without
selecting its overlay. Add the existing pinned skills and guidance at the launch
boundary, after workspace overrides and before remote skill resolution. Preserve
the selected profile name, runtime key, persona, settings and tool selections.
Claude remains opt-in. Do not modify core or global plugin/hook configuration.
This supersedes the Codex opt-in policy from `integrate-ponytail-overlay`.

Test default activation, idempotency, explicit source overrides and agent
isolation, then inspect real Codex and Claude dry-run runtimes. Runtime guidance
must still honor a user's in-conversation Ponytail mode/off request.
