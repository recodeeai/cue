# Ponytail

[Ponytail](https://github.com/DietrichGebert/ponytail) skills are enabled by default
for Cue-managed Codex launches. Claude Code remains opt-in. Both reuse Cue's
remote skill resolver; no new loader or runtime service.

## Use

Codex automatically gets all six skills and Ponytail coding guidance alongside
the selected profile, including composites and workspace persona overrides:

```sh
cue launch codex
cue launch codex --cue-profile frontend
```

No `+ponytail` suffix is needed. The selected profile name, runtime directory,
settings, and project pin remain unchanged. Normal skill filtering does not
remove this default. `CUE_BYPASS=1` still bypasses Cue entirely.

For Claude, select `ponytail` or compose it with a domain profile. Explicit
Ponytail selection also remains supported on Codex without duplicating guidance:

```sh
cue launch codex --cue-profile frontend+ponytail
cue launch claude --cue-profile frontend+ponytail
```

Ask for `ponytail lite`, `ponytail full`, or `ponytail ultra`; say
`stop ponytail` to disable its guidance in the conversation. The six upstream
skills also include review, audit, debt, gain, and help. Reviews remain opt-in.

## Scope and updates

The profile pins upstream revision
`974d940a1c5344210874150b98ff0d2c861fab6a`. Update the pin deliberately and verify
`cue validate ponytail` plus an actual `cue launch ... --dry-run`; schema
validation alone does not prove the remote skills can be fetched.

This integration installs skills, not the upstream plugin: it does not install
lifecycle hooks, status lines, an MCP server, or global agent configuration.
Upstream plugin configuration/default-mode instructions in the help skill apply
to a separate plugin installation, not this overlay. Activation here comes from
the profile's guidance and user skill requests, not a per-prompt hook.

The separate Git clone is for source inspection. Cue fetches the pinned skills
independently, so the profile does not require a host-specific checkout path.
