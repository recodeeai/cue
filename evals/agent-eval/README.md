# cue-agent-eval

A/B test cue **profiles** with [`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval).
Same task, same model, run in an isolated sandbox — the **only variable is the
cue profile's `CLAUDE.md`** (persona + rules + skill-routing). The output is a
**pass rate** per profile, so "gstack is better than core for X" stops being a
vibe and becomes a number.

```
experiments/core.ts       baseline
experiments/gstack.ts     58-role full profile
experiments/improver.ts   goal-with-a-check loop
evals/create-button/      one starter task (PROMPT.md + EVAL.ts)
lib/with-profile.ts       injects a profile's CLAUDE.md into the sandbox
```

## How a profile becomes the variable

`lib/with-profile.ts` adds a `setup()` that runs **on the host**:

1. `cue launch <profile> --rematerialize` — materializes the profile's full
   runtime (persona + rules + skill-routing + `_always` fragments → `CLAUDE.md`)
   **without exec'ing claude**, and prints `{ runtimeDir }`.
2. Reads that `CLAUDE.md` and writes it into the sandbox project root, so the
   in-sandbox Claude Code runs under that profile's instructions.

**Not injected** (by design): MCP servers, hooks, and the headroom proxy env.
They need keys/network and would fail to start in a throwaway sandbox. The
measured variable is the profile's *instructions*, not its infra. Skill **bodies**
aren't injected yet either (the `CLAUDE.md` already carries each profile's skill
list + routing) — see the extension note at the bottom of `lib/with-profile.ts`.

## Prerequisites

- `@vercel/agent-eval` — installed globally (`agent-eval --help`).
- **Docker** — the experiments use `sandbox: 'docker'` (no Vercel token needed).
- **An agent API key** — `ANTHROPIC_API_KEY` (direct, the default) **or**
  `AI_GATEWAY_API_KEY` (gateway). Without one the sandbox can't authenticate, so
  runs fail. `--dry` needs no key.
- `cue` on `PATH` (this repo's CLI) — `with-profile.ts` shells out to it.
  Run the eval from a **plain shell**, not from inside a cue-launched session:
  `CUE_LAUNCHING=1` trips cue's recursion guard and `--rematerialize` would fail.

## Run

```bash
cd evals/agent-eval
cp .env.example .env          # add ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY)
npm install                   # only needed to typecheck / run EVAL.ts locally

npx @vercel/agent-eval --dry  # preview all 3 profiles — no API calls, no cost
npx @vercel/agent-eval        # run all 3 (core, gstack, improver)
npx @vercel/agent-eval core   # run just one
npx @vercel/agent-eval --smoke  # one run per experiment — verify keys/sandbox
```

Results land in `results/<experiment>/<timestamp>/`. Compare `passRate` in each
`summary.json` across the three profiles.

## Extend

- **More tasks:** add `evals/<task>/` with `PROMPT.md` + `EVAL.ts` (+ `package.json`,
  `src/`). They run against every experiment automatically.
- **More profiles:** copy an experiment file and change `withProfile('<name>')`.
- **All profiles:** map `withProfile` over `cue list` output from a generator
  script (heavier; most configs you'd never run — start with the 3 here).

## Cost note

Each run spins up a sandbox, installs Claude Code, and runs the agent. `runs: 3`
× 3 profiles × tasks = real API tokens. Start with `--dry`, then `--smoke`, then
a full run on a small task set.

## Ponytail skill A/B (Codex)

This is separate from the profile experiments above: `skill-ab/` compares
the Cue guidance before and after PR #184, with the **same complete upstream
Ponytail skill body** included directly in sandbox `AGENTS.md`. It does not
depend on the agent discovering or opening a skill. It measures instruction
content, not skill routing, hooks, MCPs, or the full Cue launch.

- Before: persona from Cue commit `645efa643020b8ce67ae4411fb55993d0f425f56`.
- After: persona from Cue commit `2f44fcb27de55cf04f5d8c17fd8609f7e28e3831`.
- Shared upstream: `DietrichGebert/ponytail@974d940a1c5344210874150b98ff0d2c861fab6a`.
- Required SKILL.md SHA-256:
  `1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2`.

The guidance snapshots are frozen for reproducibility, not silently read from
today's profile. The skill is read from an existing local file and verified;
there are no downloads, rematerialization, or host-config writes in setup.
Only the integration guidance differs between the arms.

### Run

Use the existing dependencies in this directory (agent-eval is pinned to
1.2.0). The local contract tests and report command use Bun; grader self-tests
also use Node. Docker and `OPENAI_API_KEY` are needed for model runs, but **not**
for `skill:test` or `skill:dry`. Set the key privately in your environment;
do not commit it or copy your personal Codex auth file into a sandbox.

```bash
cd evals/agent-eval
export CUE_EVAL_MODEL="gpt-6-astra" # choose an explicit ID available to your account
export CUE_EVAL_SKILL="/absolute/path/to/ponytail/SKILL.md"
# If omitted, CUE_EVAL_SKILL defaults to $CODEX_HOME/skills/ponytail/SKILL.md
# (or ~/.codex/skills/ponytail/SKILL.md).

bun run skill:test   # offline contract/grader checks, no model calls
bun run skill:dry    # preview the two arms and five tasks, no model calls
bun run skill:smoke  # PAID: one task per arm, only a setup check
bun run skill:eval   # PAID: 2 arms × 5 tasks × 3 runs = 30 agent runs
```

Both arms require the same explicit model ID; native defaults are refused.
They use Docker, a 300-second per-run timeout, and `earlyExit: false`.
The commands always use `--force`: agent-eval 1.2.0 cannot fingerprint setup
function contents, so cached results must not hide a guidance change.
See the [upstream result-reuse contract](https://github.com/vercel-labs/agent-eval#result-reuse).
No new model runs are added to the existing profile-eval commands or CI.
The scripts preflight both variants before invoking the CLI: in 1.2.0,
`run-all` can otherwise print config-load errors and still exit successfully.

### What is checked

| Task | Acceptance and regression coverage |
| --- | --- |
| shared-limit | Zero/default/boundaries and invalid input across both callers |
| query-encoding | Encoding, repeated values, omitted values, unchanged helper |
| stable-dedupe | First occurrence, identity, ordering, falsy keys, no mutation |
| settings-patch | Atomic validation, structured errors, false values, no mutation |
| async-cleanup | Awaited cleanup on success/rejection/throw, error propagation |

Graders execute behavior rather than search for implementation keywords. Existing
checks and package contracts must remain intact. `EVAL.ts` is withheld from the
agent by agent-eval. Host-only self-tests prove each grader rejects the broken
starter and accepts a reference repair; those repairs are outside fixture folders.
Each fixture pins Vitest 2.1.0 for Docker validation. Offline self-tests run the
same assertions through Node's test runner, not Docker or a model invocation.
These are synthetic starter tasks, not a representative production benchmark.

### Compare

Choose the timestamp directory from **each complete run**, not the top-level
results directory:

```bash
bun run skill:report \
  skill-ab/results/ponytail-before/<timestamp> \
  skill-ab/results/ponytail-after/<timestamp>
```

The JSON report includes overall and per-task pass rates, task-level decreases
in passing runs, mean elapsed seconds, and mean input-plus-output tokens.
Elapsed time is the runner's reported duration, not isolated model latency.
It refuses incomplete samples, known infrastructure-invalid summaries, and
mismatched models, task hashes, or skill/guidance hashes. Snapshot hashes are
saved in each run's `metadata.cueSkillAb`.

Tokens come from Codex `turn.completed.usage`, not estimates; cached input is
already part of input tokens and is not added again. Missing usage is `null`,
not zero. See the [Codex JSONL event format](https://developers.openai.com/codex/noninteractive).
If the adapter cannot observe the actual model, `observedModelVerified` is false.
Inspect raw transcripts before drawing conclusions, especially failures without
an infrastructure classification. Three repetitions are exploratory evidence,
not statistical proof or a release gate. Compare correctness before time/tokens;
there is deliberately no line-count score or automatic winner.
