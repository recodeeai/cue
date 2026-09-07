# Tasks

- [x] Add regression coverage for Codex defaults and unchanged Claude behavior.
- [x] Apply Ponytail skills and guidance without replacing selected-profile settings.
- [x] Update activation documentation and run focused checks and real launches.

## Verification

- New default-activation tests first failed with a no-op implementation.
- `bun test src/lib/ponytail-profile.test.ts src/commands/launch.test.ts`:
  95 passed, 262 assertions.
- Launcher parsing, account-runtime, launch E2E, handoff E2E and workspace tests:
  96 passed, 194 assertions, no skips. E2E caches include Ponytail fixtures, so
  the tests do not fetch the new default from the network.
- Targeted Biome lint (five TypeScript files), `bun run typecheck`, `bun run build`
  and strict OpenSpec validation passed.
- Real dry launches in isolated config directories: plain `core` and
  `frontend+browser` Codex runtimes retained their names, included all six skill
  files byte-identical to the upstream clone, and included the guidance once.
  Plain Claude `core` had no implicit Ponytail skill or guidance.
- A real workspace-persona override retained both its own text and the default
  Ponytail guidance. Tests used the initialized main checkout's resources with
  isolated worktree profile definitions; no global agent settings were edited.

Record final PR merge and owned-lane cleanup proof in the PR completion comment.
