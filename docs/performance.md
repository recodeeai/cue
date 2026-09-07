# Cue startup measurement

Run `bun scripts/benchmark-startup.ts` from the checkout to measure the real
`bin/cue launch codex --cue-profile backend --cue-full` handoff. The script uses
a disposable home/config/cache and an agent stub: it never starts a model or MCP
server, reads account credentials, or downloads skills. Remote skill cache
entries contain fixture bodies; local skills come from the pinned submodule.

Two scenarios each report seven samples and their median:

- **Warm runtime:** retain the generated runtime between launches.
- **Cold runtime:** remove only that disposable runtime before each launch;
  remote skills and the profile manifest remain cached. This is not a cold
  machine/install benchmark.

## 2026-09-07 local comparison

Linux, Bun 1.3.13, Node 22.22.0; baseline `2d08be73`. Baseline and candidate
used matching temporary checkout layouts, the same pinned resource trees,
and the same benchmark script. Run order was candidate/base/base/candidate,
giving 14 samples per variant per scenario. Median of the combined samples:

| Scenario | Baseline | Candidate | Difference |
| --- | ---: | ---: | ---: |
| Warm runtime | 285 ms | 269 ms | 5.6% lower |
| Cold runtime | 841 ms | 640 ms | 23.9% lower |

The cold-runtime improvement follows removal of repeated skill-directory
scans: one lazy directory index is shared within each launch/install, while
every lookup still checks SKILL.md and retains ambiguity/traversal errors.
There is no persistent index to invalidate between launches. The regression
test asserts one root scan even for concurrent lookups; timing is not a CI
assertion because filesystem cache and other host activity vary.

The small warm-runtime difference is not evidence of a reliable warm-start
speedup. These figures measure Cue overhead only, with project loadout disabled
by `--cue-full`; they do not predict model response time or normal network-bound
first installation. Repeat the benchmark on the target machine/profile before
generalizing the result.
