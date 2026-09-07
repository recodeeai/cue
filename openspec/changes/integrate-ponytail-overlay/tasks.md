# Tasks

- [x] Clone and inspect the upstream repository and its six skills.
- [x] Add a pinned, opt-in Ponytail profile without global plugin hooks.
- [x] Test standalone/composite profile loading and real launch materialization.
- [x] Document activation, pinning, and skills-only integration boundaries.

## Verification

- `bun test src/lib/ponytail-profile.test.ts`: 3 passed, 83 assertions; covers
  core preservation and frontend/Next.js composition.
- `bunx --no-install biome lint src/lib/ponytail-profile.test.ts`: passed.
- `bun run typecheck`: passed.
- `cue validate ponytail`: passed; inherited core warnings remain unchanged.
- `openspec validate integrate-ponytail-overlay --strict`: passed.
- Real `cue launch <agent> --cue-profile <profile> --dry-run` materialization
  succeeded for Codex and Claude with `ponytail` and `frontend+ponytail`.
  Each runtime's six skill files matched the pinned Git checkout byte-for-byte.
  Validation used `CUE_PROFILES_DIR` for the isolated profile definitions and
  the installed Cue checkout's initialized resource submodules.
- The Next.js full-load launch failed fetching its existing
  `vercel/vercel-plugin` dependency. The same failure reproduced with plain
  `nextjs` without Ponytail; that unrelated source was not modified.

Delivery evidence (PR, merge and owned-lane cleanup) belongs in the PR completion
comment after those operations finish.
