---
layout: default
title: "cue — Per-project profile manager for Claude Code & Codex"
description: "Your agent reads every skill you own, on every message. cue loads only the ones that project needs. Install: npm install -g cue-ai"
image: https://opencue.github.io/cuecards/assets/og-card.png
---

# Your agent reads every skill you own, on every message

**New to Cue? [Start at cuecards.cc](https://cuecards.cc)** to learn how profiles
work, browse community profiles, and try them through the Cue CLI on your machine.
This GitHub Pages site remains the documentation and registry.

**cue loads only the ones that project needs.** Per-project profiles scope which
skills, MCP servers, and persona load — automatically, before Claude Code or
Codex launches. Ten agents supported from one profile.

```bash
npm install -g cue-ai && cue setup
```

---

## 🏆 Top 10 Hidden Gems

| | Repo | Score | Profile | What it does |
|---|------|-------|---------|-------------|
| 💎 | [wedding-invitation-skill](https://github.com/wyx-sg/wedding-invitation-skill) | 15 | core | AI skill that designs wedding invitations from conversation |
| 💎 | [Deliberation-Loop](https://github.com/butevecom-commits/Deliberation-Loop) | 11.5 | core | Multi-path reasoning via 6-role structured debate |
| 💎 | [the-council](https://github.com/DantesPeak85/the-council) | 11.5 | core | Multi-model advisory board — second opinions from GPT-4, Gemini |
| 💎 | [claude-ecosystem-health](https://github.com/aplaceforallmystuff/claude-ecosystem-health) | 10.4 | backend | Detect drift between skills, agents, MCP servers |
| 💎 | [moodle-quizsmith](https://github.com/Rick-254/moodle-quizsmith) | 10 | core | Moodle MCQ Generator for GIFT XML & Aiken |
| 💎 | [dokpilot](https://github.com/kyzdes/dokpilot) | 9.8 | backend | VPS deployment via Dokploy — setup, deploy, domains |
| 💎 | [pre-sales_career_navigator](https://github.com/diabolikss-debug/pre-sales_career_navigator) | 9 | core | Analyzes pre-sales experience, generates career paths |
| 💎 | [skill-ci](https://github.com/QuickClaw-Skills/skill-ci) | 8.5 | core | Reusable CI workflow — validates SKILL.md format |
| 💎 | [plugins](https://github.com/glitchwerks/plugins) | 8.3 | core | Claude Code plugins marketplace |
| 💎 | [Cursor-history-MCP](https://github.com/pedrohenrique316/Cursor-history-MCP) | 8 | backend | Extract and vectorize Cursor chat history |

[→ Full discovered list](./discovered.md)

---

## Profiles

| Profile | Domain |
|---------|--------|
| [core](./discovered.md#-core-23-gems) | Baseline — memory, reasoning, meta skills |
| [backend](./discovered.md#-backend-6-gems) | APIs, deployment, diagnostics |

---

## Install

```bash
npm install -g cue-ai && cue setup
```

`cue setup` installs the `claude`/`codex` shim, scans this project, and pins
the matching profile. Already have an agent open? Paste the
[agent install prompt](https://github.com/opencue/cuecards/blob/main/setup/agent-prompt.md)
into it instead — it does the same thing, asking before it touches anything.

[GitHub →](https://github.com/opencue/cuecards)
