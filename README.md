<div align="center">

# cuecards

**Your agent reads every skill you own, on every message. cue loads only the ones that project needs.**

<p align="center">
  <img src="https://raw.githubusercontent.com/opencue/cuecards/main/docs/assets/hero.svg" alt="cuecards — agent profile manager for Claude Code and Codex" width="820">
</p>

<p align="center">
  <a href="https://github.com/opencue/cuecards/stargazers"><img src="https://img.shields.io/github/stars/opencue/cuecards?style=for-the-badge&logo=github&label=%E2%AD%90%20Star%20this%20repo&color=yellow" alt="Star cuecards on GitHub"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cue-ai"><img src="https://img.shields.io/npm/v/cue-ai?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/cue-ai"><img src="https://img.shields.io/npm/dw/cue-ai?style=for-the-badge&label=downloads&color=2b3137" alt="npm downloads"></a>
  &nbsp;
  <a href="https://github.com/opencue/cuecards/blob/main/LICENSE"><img src="https://img.shields.io/github/license/opencue/cuecards?style=for-the-badge&label=license&color=4c1" alt="MIT license"></a>
  &nbsp;
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 20+">
  &nbsp;
  <img src="https://img.shields.io/badge/telemetry-none-success?style=for-the-badge" alt="zero telemetry">
</p>

[Install](#install) · [How it works](#how-it-works) · [Profiles](#85-ready-made-cuecards) · [Multi-agent](#one-cuecard-ten-agents) · [FAQ](#faq) · [Contributing](#contributing)

</div>

---

## Install

**Already have an agent open?** Paste this into Claude Code, Codex, Cursor, or
whatever you use — it installs cue and sets up this project, asking before it
touches anything:

```text
Install cue (https://github.com/opencue/cuecards) on this machine and set it up
for this project.

1. Check Node >= 20 with `node --version`. If it's missing or older, stop and tell me.
2. Check whether cue is already installed: `command -v cue`. If it resolves, skip to 4.
3. Ask me before installing anything, then run: `npm install -g cue-ai`
4. Run `cue auto-detect --json`. Show me the profile suggestions it returns and what
   each one is for, and let me pick one — don't choose for me.
5. Run `cue setup --profile <the one I picked> --yes`. That pins the profile,
   installs the shim that makes `claude`/`codex` load it, and — if needed —
   configures the shim directory on PATH (shell rc on Linux/macOS, Current User
   PATH on native Windows) so the shim takes effect. It will not enable telemetry and will not install
   third-party skills. If it exits non-zero, stop and show me the output
   instead of continuing to step 6.
6. If it prints PATH guidance, show it verbatim — the shims do nothing until that
   line is added.
7. Report which profile got pinned and whether the shim is active. Mention that
   `install.sh --uninstall` undoes it.

Do not install anything without asking me first.
```

**Rather type it yourself?**

```bash
npm install -g cue-ai && cue setup
```

`cue setup` installs the `claude`/`codex` shim, scans this project, shows what
the matching profile costs against loading everything, and pins it. On the
first interactive run it also asks before installing the recommended local
tooling: CodeGraph (`@colbymchenry/codegraph`), a repository index, and the
CodeGraph + Context7 MCP configuration supplied by the core profile. Declining
is safe, and `cue setup --re-onboard` offers it again. Non-interactive `--yes`
runs never perform this global third-party install without explicit consent.

Setup requires Node ≥ 20 and an existing
[Claude Code](https://github.com/anthropics/claude-code) or
[Codex](https://github.com/openai/codex) install — cue is a thin shim that hands
off to your real agent, not a replacement for it.

After setup, a bare interactive `codex` opens Cue's profile suggestion picker
on Linux, macOS, PowerShell, and cmd.exe. `codex <args>` remains non-interactive
unless you pass `--cue-pick`.

> package `cue-ai` · command `cue` · repo [opencue/cuecards](https://github.com/opencue/cuecards)

Three things happen when you type `claude` afterwards:

1. The shim resolves this directory's `.cue.profile`.
2. cue materializes only that profile's skills, MCPs, and persona into a runtime.
3. The real Claude Code binary starts against it.

Pin a different project to a different profile:

```bash
cd ~/projects/my-shop
cue use medusa-dev      # writes .cue.profile in this directory
claude                  # launches with the medusa-dev loadout
```

Not sure which fits? `cue auto-detect` reads your project (package.json,
pyproject.toml, Cargo.toml, …) and suggests one.

<details>
<summary>Other install paths (script, clone, guided)</summary>

| Path | Command |
|---|---|
| One-line script | `curl -fsSL https://raw.githubusercontent.com/opencue/cuecards/main/get.sh \| bash` |
| Manual clone | `git clone https://github.com/opencue/cuecards.git && ./cuecards/install.sh` |
| Per-OS notes (Homebrew, WSL2, PowerShell PATH) | [setup/macos.md](https://github.com/opencue/cuecards/blob/main/setup/macos.md) · [setup/linux.md](https://github.com/opencue/cuecards/blob/main/setup/linux.md) · [setup/windows.md](https://github.com/opencue/cuecards/blob/main/setup/windows.md) |

All paths are idempotent — safe to re-run. `install.sh --help` lists `--yes`,
`--codex`, `--uninstall`.

</details>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/opencue/cuecards/main/docs/assets/demo.gif" alt="cue picking a cuecard and launching the agent" width="820">
</p>

## Why this exists

If you've been using AI coding agents for a while, you've probably collected a pile of skills, MCP servers, and custom instructions. Maybe hundreds. Here's the problem:

**your agent re-reads all of them, on every single message** — including the 95% that have nothing to do with the task in front of it.

That hurts twice:

1. **You pay for it.** Every always-loaded skill description and MCP schema is input tokens, billed on every turn of every session.
2. **Your agent gets dumber.** Picking the right tool out of 330 irrelevant ones is harder than picking it out of 12 relevant ones.

cue fixes this by scoping everything per directory. Your Medusa shop loads the Medusa cuecard. Your Rust CLI loads the Rust cuecard. Nothing else comes along for the ride.

### Before vs after — in numbers

<p align="center">
  <img src="https://raw.githubusercontent.com/opencue/cuecards/main/docs/assets/isolation-comparison.svg" alt="Everything-loaded vs a scoped cuecard — always-on context compared" width="820">
</p>

| Loadout | Always-on context | Cost / 100 msgs (Sonnet input) |
|---|---|---|
| Everything loaded (`full` profile) | ~81k tokens | ~$24 |
| `backend` cuecard | ~9k tokens | ~$2.70 |
| `caveman-quick` cuecard | ~6.8k tokens | ~$2.00 |

That's **9–16× less always-on context**, compounding on every message. Reproduce the numbers yourself:

```bash
cue cost              # token budget for your active profile
cue cost --compare    # every profile ranked against the `full` baseline
```

---

## What is a cuecard?

A cuecard (also called a *profile*) is everything your agent needs to be useful in one project, bundled into a single `profile.yaml`:

| Layer | What it controls |
|---|---|
| **Skills** | Only the ones this project actually needs |
| **MCP servers** | Scoped per directory — no global sprawl |
| **Plugins** | The Claude Code plugins this project wants, no more |
| **Persona** | How the agent thinks, writes, and self-edits |
| **Playbooks** | Step-by-step procedures for known tasks |
| **Gates** | What must pass before the agent can claim "done" |

One cuecard per project. Your agent reads the right one the moment you launch it. That's what makes a cuecard more than a skills list — it's composable expertise, not just "more tools loaded."

---

## How it works

No daemon, no background process. cue intercepts the *call* to your agent, resolves the directory's cuecard, materializes it once, then hands off to the real binary:

<p align="center">
  <img src="https://raw.githubusercontent.com/opencue/cuecards/main/docs/assets/architecture.svg" alt="cue resolve to materialize to exec flow" width="820">
</p>

```
you type `claude`
       │
       ▼
 ~/.config/cue/shims/claude ──► cue launch
       │
       ▼
 resolve  ──►  which cuecard owns this directory?  (.cue.profile / auto-detect)
       │
       ▼
 materialize ──►  build the runtime (skills + MCPs + persona + gates)
       │           sha256-cached — rebuilds only when something changed
       ▼
 exec  ──►  the real Claude Code / Codex, scoped to this project
```

Cold start 50–200 ms, warm start under 5 ms. Nothing stays resident. Full flow: [docs/launch.md](https://github.com/opencue/cuecards/blob/main/docs/launch.md).

---

## 193 ready-made cuecards

cue ships with 98 focused primary profiles plus 94 opt-in overlays. A taste:

| Profile | What it's for |
|---|---|
| 🐢 **core** | Minimal baseline shared by every profile |
| 🐻 **backend** | APIs, webhooks, security review, CI, databases, deploys |
| 🦋 **frontend** | UI implementation, redesigns, screenshots, browser testing |
| ▲ **nextjs** | Next.js App Router, Server Components, Vercel |
| 🐍 **python** | FastAPI/Django/Flask, SQLAlchemy, pytest |
| 🦀 **rust** | Async, web, CLI/TUI, embedded, FFI, WASM |
| 🦊 **medusa-dev** | Medusa v2 backend, storefront, admin |
| 🔒 **cybersecurity** | 754 red/blue-team skills + audit tooling |
| 🦜 **marketing** | Copywriting, SEO, CRO, growth |
| 🐝 **docs-writer** | Documentation, Markdown, PDF, structured writing |
| 🏢 **agency** | 63 delegatable subagents — design, sales, product, PM, QA |

```bash
cue list           # see all 193
cue auto-detect    # suggest the right one for the current directory
cue use <name>     # pin it
```

Full machine-readable catalog: [docs/data/profiles.md](https://github.com/opencue/cuecards/blob/main/docs/data/profiles.md). Nothing fits? `cue ai "describe your stack"` scaffolds a new one.

---

## One cuecard, ten agents

The same `profile.yaml` materializes into each agent's native config format — write your setup once, use it everywhere:

| Agent | Output |
|---|---|
| Claude Code / Codex | runtime dirs under `~/.config/cue/runtime/` (via the shim) |
| Cursor | `.cursorrules` + `.cursor/mcp.json` |
| Cline | `.clinerules` + `cline_mcp_settings.json` |
| Gemini CLI | `~/.gemini/skills/*.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurfrules` + `.windsurf/mcp.json` |
| Roo Code | `.roo/rules/*.md` + `.roo/mcp.json` |
| Sourcegraph Amp | `AGENTS.md` + `.amp/mcp.json` |
| Aider | `.aider.conventions.md` |

```bash
cue materialize cursor --profile backend   # one agent
cue materialize --all --profile backend    # all ten at once
```

---

## Built-in rigor

cuecards don't just load tools — they hold your agent to a standard.

**The reviewer gate.** Profiles can enable an independent review gate: when the agent finishes a code-producing turn, cue spawns a *fresh, separate* reviewer agent over the diff before the turn is allowed to finish. A real catch from a live session: the reviewer flagged a unit bug where a product's `weight` was kilograms in one place and grams in two others — left in, carts would have displayed `20000 kg`. The gate held the merge until it was fixed.

Enable it with `touch ~/.config/cue/auto-review-enabled`, watch reviews live with `cue-review-watch`, and skip one turn with `[skip-auto-review]`. Details: [docs/review-visibility.md](https://github.com/opencue/cuecards/blob/main/docs/review-visibility.md).

**The install gate.** Every path that lands a new skill on disk — `cue skills add`, `cue discover install`, `cue marketplace install-skill` — is scanned by [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector) before the skill is registered to a profile. Research behind that scanner puts 26.1% of published skills at "contains vulnerabilities" and 5.2% at "likely malicious intent", so a skill you found on GitHub 30 seconds ago does not get to run on trust.

A `DO_NOT_INSTALL` verdict blocks: the files stay on disk for review but never reach your `profile.yaml`. `CAUTION` registers with a warning. `SAFE` passes silently. Override a block with `--allow-unsafe`, scan anything by hand with `cue security scan <path>`, and turn the gate off with `CUE_SKILLSPECTOR=0`.

```console
$ cue security scan ./notes-organizer/
🔴 SkillSpector: DO_NOT_INSTALL (risk 85/100, CRITICAL) — 6 finding(s): Anti-Refusal, Privilege Escalation, Prompt Injection, YARA Match
   [HIGH] AR3 Anti-Refusal SKILL.md:8
   [HIGH] PE3 Privilege Escalation SKILL.md:13
   [HIGH] P1  Prompt Injection SKILL.md:8
```

No setup needed: cue uses `skillspector` if it's on your PATH, otherwise runs it through `uvx` (cached after the first run), otherwise a local docker image. If none of those exist the gate says so out loud and falls back to cue's own SEC1-7 rules rather than silently passing. Scans run with `--no-llm`, so skill contents never leave your machine.

**Baselines for reviewed false positives.** Pattern scanners produce noise — one of cue's own skills got flagged for "Env Variable Harvesting" because a comment contains the word *token*. `cue security baseline <path>` records the current findings with a written reason so later scans surface only new ones. Suppression is exact: fingerprints bind to the scanner version and the skill's full source, so editing the skill reactivates the finding until someone re-reviews it. Baselines apply to this repo's own skills only, never to a fetched remote skill — its id is chosen by whoever wrote it.

**Confidence tags.** cue-managed agents tag research- and decision-relevant claims with colored confidence markers so you can scan trust at a glance:

| Tier | Tags | Meaning |
|---|---|---|
| 🟢 | `[VERIFIED]` `[KNOWN]` | Checked firsthand / well-documented fact |
| 🟡 | `[INFERRED]` `[ASSUMED]` | Deduced or assumed — verify if stakes matter |
| 🟠 | `[GUESSED]` `[STALE]` | Pattern-match or possibly outdated — verify first |
| 🔴 | `[UNKNOWN]` | The agent said "I don't know" instead of making it up |

---

## Everyday commands

```bash
# Profiles
cue use <profile>            # pin a profile to this directory
cue list                     # all available profiles
cue auto-detect              # suggest one for the current project

# Cost
cue cost                     # token budget for the active profile
cue cost --compare           # all profiles ranked vs `full`

# Skills & discovery
cue discover search <query>  # find skills on GitHub
cue discover install <skill> # install one (SkillSpector-gated)
cue lint-skill <path> --fix  # validate a SKILL.md

# Security
cue security                 # scan the active profile's skills
cue security scan <path>     # deep NVIDIA SkillSpector scan of any skill
cue security --all --json    # every skill, machine-readable

# Marketplace (push your own to cuecards.cc)
cue marketplace login --token <t>          # save the API token from the studio → API view
cue marketplace publish profile ship-fast  # push a profile / skill / mcp for everyone

# Health
cue doctor --fix             # diff declared vs actual state, auto-repair
cue optimizer                # dashboard: skills, MCPs, CLIs, usage per profile
cue failures --propose       # let Claude draft profile improvements from failures
```

`cue --help` shows the full ~50-subcommand surface; the set above covers a typical week.

<p align="center">
  <img src="https://raw.githubusercontent.com/opencue/cuecards/main/docs/assets/optimizer-dashboard.svg" alt="cue optimizer dashboard — skills, MCPs, CLIs, and usage per profile" width="820">
</p>

---

## FAQ

<details>
<summary><b>Does this break Claude Code's auto-update?</b></summary>

No. cue never touches the `claude` binary, and never writes to `~/.local/bin` where the native installer keeps it. It intercepts the *call* via a one-line bash shim in its own `~/.config/cue/shims/`, sets `CLAUDE_CONFIG_DIR`, and `exec`s the real binary. Updates work exactly as before — the installer rewrites its symlink, the shim is untouched, and the next launch picks up the new version.
</details>

<details>
<summary><b>Is this a daemon?</b></summary>

No. Pure CLI. When you type `claude`, the shim runs `cue launch`, compares a sha256, materializes only if something changed, then `exec`s. Nothing stays resident.
</details>

<details>
<summary><b>How much overhead does it add?</b></summary>

Cold start 50–200 ms; warm start under 5 ms. Imperceptible next to your agent's own startup.
</details>

<details>
<summary><b>Does cue send telemetry?</b></summary>

No. Everything cue computes — including the per-skill usage bars in `cue optimizer` — reads from your local transcript files. Nothing leaves your machine.
</details>

<details>
<summary><b>What does cue NOT do?</b></summary>

- It doesn't modify or repackage the Claude Code / Codex binaries.
- It doesn't lock you in — skills live in your repo or come from open source; the optional [cuecards.cc marketplace](https://github.com/opencue/cuecards/blob/main/docs/marketplace-api.md) is just a sharing layer you push to with your own token, never a requirement.
- It doesn't coordinate multi-agent runs (that's [colony](https://github.com/recodeee/colony) + [gitguardex](https://github.com/recodeee/gitguardex), layered on top via the parallel-agents tier).
</details>

---

## How it compares

|  | cuecards | skillport / agent-skills-cli | Kiro Powers |
|---|---|---|---|
| Skills | ✅ | ✅ | ✅ |
| MCPs | ✅ | — | ✅ |
| Plugins | ✅ | — | — |
| Per-directory profiles | ✅ | — | ◐ (IDE-only) |
| Inheritance | ✅ | — | — |
| Persona / playbooks / gates | ✅ | — | — |
| Multi-agent (Cursor/Cline/Copilot/…) | ✅ (10) | Claude only | IDE-only |
| Failure-feedback loop | ✅ | — | — |
| Daemon required | none | none | IDE process |

---

## Deep dives

| Topic | Read |
|---|---|
| Launch flow (resolve → materialize → exec) | [docs/launch.md](https://github.com/opencue/cuecards/blob/main/docs/launch.md) |
| Full profile catalog | [docs/data/profiles.md](https://github.com/opencue/cuecards/blob/main/docs/data/profiles.md) |
| Bootstrap contract for AI agents installing cue | [AGENTS.md](https://github.com/opencue/cuecards/blob/main/AGENTS.md) |
| Parallel agents tier (Colony + gitguardex) | [setup/parallel-agents.md](https://github.com/opencue/cuecards/blob/main/setup/parallel-agents.md) |
| Confidence-tag system | [integrity-tags/SKILL.md](https://github.com/opencue/cuecards/blob/main/resources/skills/skills/meta/integrity-tags/SKILL.md) |
| Publish profiles, skills, and MCPs with an API token | [docs/marketplace-api.md](https://github.com/opencue/cuecards/blob/main/docs/marketplace-api.md) |
| How the shims work, per shell | [docs/shell-setup.md](https://github.com/opencue/cuecards/blob/main/docs/shell-setup.md) |

---

## Contributing

```bash
git clone https://github.com/opencue/cuecards.git
cd cuecards && bun install
bun test                          # tests (lib + commands)
bun run src/index.ts --help       # run locally
```

| Want to | Run |
|---|---|
| Add a skill | `cue skills-new <name>`, then edit `resources/skills/skills/<category>/<name>/SKILL.md` |
| Add a profile | `cue new <name>`, then `cue validate <name>` |
| Share your profile | `cue share publish --profile <name>` |
| Report a bug | [Open an issue](https://github.com/opencue/cuecards/issues) |

---

<div align="center">

Built by [Viktor Nagy](https://github.com/NagyVikt) at [opencue](https://github.com/opencue) · [opencue.github.io/cuecards](https://opencue.github.io/cuecards/)

**If cue saves you tokens, star it — that's how other people find it.**

<a href="https://github.com/opencue/cuecards/stargazers"><img src="https://img.shields.io/github/stars/opencue/cuecards?style=for-the-badge&logo=github&label=%E2%AD%90%20Star%20this%20repo&color=yellow" alt="Star cuecards on GitHub"></a>

License: [MIT](https://github.com/opencue/cuecards/blob/main/LICENSE) · zero telemetry · no daemon

</div>
