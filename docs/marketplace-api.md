# Marketplace API

Publishing profiles, skills, and MCPs to cuecards.cc from your own machine.
Not needed to use cue — see the [README](../README.md) to get started.

cuecards.cc gives every account a free, per-user **API token** and a small HTTP
API. Mint a token in the studio (`cue dashboard` → **API** view, or
[cuecards.cc](https://cuecards.cc)), then use it from your own machine to push
profiles, skills, and MCPs to the community marketplace.

```bash
# 1. Save the token (verifies it against the server before writing ~/.config/cue/credentials.json)
cue marketplace login --token cue_sk_…       # or: export CUE_API_TOKEN=cue_sk_…
cue marketplace whoami                        # confirm which account you're authenticated as

# 2. Push something to the marketplace
cue marketplace publish profile ship-fast --source-url https://github.com/me/ship-fast --tags build,review
cue marketplace publish skill seo-audit --source-url https://github.com/me/skills
cue marketplace publish mcp my-server --desc "internal tooling MCP"
```

Authenticate HTTP calls with a Bearer header (the token also works as
`x-api-key`):

```bash
curl https://cuecards.cc/api/v1/me            -H "Authorization: Bearer $CUE_API_TOKEN"
curl https://cuecards.cc/api/v1/community     # public community catalog (no auth)
curl https://cuecards.cc/api/v1/community     -H "Authorization: Bearer $CUE_API_TOKEN" \
  -X POST -H 'content-type: application/json' \
  -d '{"type":"profile","name":"ship-fast","sourceUrl":"https://github.com/me/ship-fast","tags":["build"]}'
```

## Share a runnable profile

Publish the profile's `profile.yaml` in a public GitHub repository first, then
submit that repository's HTTPS URL as `sourceUrl`. A profile in a subdirectory
can use `https://github.com/me/profiles/tree/main/ship-fast`; a commit SHA
instead of `main` pins the reviewed version. Publishing adds a catalog listing,
not a copy of the YAML. The CLI fetches the source when someone installs it.

Readers review the GitHub source, including referenced skills, MCP commands, and
hooks, then run the card's command locally:

```bash
cue share install me/ship-fast
# Review the saved profile; installation does not activate it.
cue use me-ship-fast
cue launch codex
```

The installer prints the saved name and path. Automation must explicitly pass
`--yes`. Source-less older listings cannot offer an install command until their
author adds a valid GitHub source. The hosted site cannot run commands on your
machine: start `cue dashboard` for the local management UI.

Shared installs currently use one slot per GitHub repository (`owner-repo`).
Installing a different subdirectory from that same repository replaces that slot;
use separate repositories to keep multiple shared profiles installed together.
Only the YAML is imported, not arbitrary files from the repository.

Install commands are **derived server-side** — a submission can never inject an
arbitrary `add` string. See [web/AUTH.md](https://github.com/opencue/cuecards/blob/main/web/AUTH.md) for the auth model,
self-hosting, and `CUE_API_URL` (point the CLI at a different deployment).
