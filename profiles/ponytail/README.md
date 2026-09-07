# Ponytail

Opt-in [Ponytail](https://github.com/DietrichGebert/ponytail) skills for Claude Code
and Codex. Reuses Cue's remote skill resolver; no new loader or runtime service.

## Use

Select `ponytail` in Cue, or compose it with a domain profile such as
`frontend+ponytail`. For a one-off launch without changing the directory's profile:

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
