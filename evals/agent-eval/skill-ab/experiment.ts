import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperimentConfig } from "@vercel/agent-eval";

export const SKILL_SHA256 = "1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2";
export const TASKS = ["async-cleanup", "query-encoding", "settings-patch", "shared-limit", "stable-dedupe"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixtureHash(root: string): string {
  const files: [string, string][] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push([path, readFileSync(join(root, path), "utf8")]);
    }
  };
  visit("");
  return hash(JSON.stringify(files));
}

export function readTokenUsage(transcript: string | undefined) {
  if (!transcript) return null;
  const total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let found = false;
  for (const line of transcript.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "turn.completed") continue;
    const usage = event.usage;
    if (!usage || ![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
      || usage.cached_input_tokens > usage.input_tokens) return null;
    total.inputTokens += usage.input_tokens;
    total.cachedInputTokens += usage.cached_input_tokens;
    total.outputTokens += usage.output_tokens;
    found = true;
  }
  return found ? total : null;
}

export function createExperiment(
  variant: "before" | "after",
  model: string | undefined,
  skill: string,
): ExperimentConfig {
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new Error("Set CUE_EVAL_MODEL to the same explicit model ID for both arms.");
  if (!skill.trim()) throw new Error("The full Ponytail skill body is required.");
  const guidance = readFileSync(new URL(`./guidance/${variant}.md`, import.meta.url), "utf8");
  const instructions = `# Ponytail skill\n\n${skill}\n\n# Cue integration guidance\n\n${guidance}`;
  const provenance = {
    variant, model, skillSha256: hash(skill), guidanceSha256: hash(guidance),
    instructionsSha256: hash(instructions),
  };
  const taskHashes = Object.fromEntries(TASKS.map((task) =>
    [task, fixtureHash(fileURLToPath(new URL(`./evals/${task}/`, import.meta.url)))]));
  return {
    agent: "codex",
    model,
    evals: [...TASKS],
    runs: 3,
    earlyExit: false,
    sandbox: "docker",
    scripts: ["test"],
    timeout: 300,
    copyFiles: "changed",
    setup: async (sandbox) => {
      await sandbox.writeFiles({ "AGENTS.md": instructions });
    },
    onRunComplete: ({ fixture, runData }) => ({
      ...runData,
      result: {
        ...runData.result,
        metadata: { ...runData.result.metadata, cueSkillAb: { ...provenance, taskSha256: taskHashes[fixture.name] } },
        analysis: { ...runData.result.analysis, tokenUsage: readTokenUsage(runData.transcript) },
      },
    }),
  };
}

export function loadExperiment(variant: "before" | "after"): ExperimentConfig {
  const model = process.env.CUE_EVAL_MODEL;
  if (!model?.trim()) throw new Error("Set CUE_EVAL_MODEL to the same explicit model ID for both arms.");
  const path = process.env.CUE_EVAL_SKILL
    ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", "ponytail", "SKILL.md");
  let skill: string;
  try { skill = readFileSync(path, "utf8"); }
  catch { throw new Error("Set CUE_EVAL_SKILL to an existing pinned Ponytail SKILL.md; this eval never downloads skills."); }
  if (hash(skill) !== SKILL_SHA256) {
    throw new Error("Ponytail skill checksum mismatch. Use the pinned skill documented in README.md.");
  }
  return createExperiment(variant, model, skill);
}

// agent-eval 1.2.0 run-all can exit 0 after failing to load every config.
// Validate both arms first so a broken setup cannot masquerade as a successful dry run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadExperiment("before");
    loadExperiment("after");
    if (process.argv.includes("--require-key") && !process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required for paid Codex runs. No model calls were made.");
    }
    console.log("Ponytail A/B preflight: both variants validated.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
