# Ponytail opt-in integration

Add the six upstream DietrichGebert/ponytail skills through Cue's existing
revision-pinned npx resolver, exposed as a core-inheriting `ponytail` overlay.
Do not modify core, existing profile selections, shared resource submodules,
global agent configuration, or plugin/hook trust settings.

The user also requested a Git clone. Keep the upstream checkout separately under
`~/Documents/ai-tools/ponytail`; do not vendor it into Cue or depend on that
machine-specific path for profile resolution.

Verify profile schema, all six real remote resolutions, standalone and composite
launch materialization, and preservation of the base profile's capabilities.
