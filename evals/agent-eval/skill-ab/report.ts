import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, type readTokenUsage } from "./experiment.js";

export interface Run {
  task: string;
  status: "passed" | "failed";
  duration: number;
  observedModel?: string;
  metadata: {
    variant: "before" | "after";
    model: string;
    skillSha256: string;
    taskSha256: string;
    guidanceSha256: string;
    instructionsSha256: string;
  };
  usage: ReturnType<typeof readTokenUsage>;
}

export function readRuns(root: string): Run[] {
  return TASKS.flatMap((task) => {
    const dir = join(root, task);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    if (summary?.totalRuns !== 3 || summary.valid === false) {
      throw new Error(`Incomplete or infrastructure-invalid task: ${task}`);
    }
    return readdirSync(dir).filter((name) => /^run-\d+$/.test(name)).sort().map((name) => {
      const data = JSON.parse(readFileSync(join(dir, name, "result.json"), "utf8"));
      const meta = data?.metadata?.cueSkillAb;
      const usage = data?.analysis?.tokenUsage ?? null;
      if (!meta || !["before", "after"].includes(meta.variant)
        || !["model", "skillSha256", "taskSha256", "guidanceSha256", "instructionsSha256"].every((key) => typeof meta[key] === "string" && meta[key])
        || !["passed", "failed"].includes(data.status) || !Number.isFinite(data.duration) || data.duration < 0
        || (data.observedModel !== undefined && typeof data.observedModel !== "string")
        || (usage !== null && (![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]
          .every((value) => Number.isSafeInteger(value) && value >= 0) || usage.cachedInputTokens > usage.inputTokens))) {
        throw new Error(`Invalid or uninstrumented run: ${task}/${name}`);
      }
      return { task, status: data.status, duration: data.duration, observedModel: data.observedModel, metadata: meta, usage };
    });
  });
}

export function compareRuns(before: Run[], after: Run[]) {
  const first = before[0];
  if (!first) throw new Error("Both experiment result directories are required.");
  if (first.metadata.guidanceSha256 === after[0]?.metadata.guidanceSha256) {
    throw new Error("The two guidance snapshots are identical; there is no A/B variable.");
  }
  for (const [variant, runs] of [["before", before], ["after", after]] as const) {
    if (runs.length !== TASKS.length * 3) throw new Error("Expected three runs of each of the five tasks per arm; smoke runs are not A/B evidence.");
    const reference = runs[0]!;
    for (const run of runs) {
      if (run.metadata.variant !== variant || run.metadata.model !== first.metadata.model
        || run.metadata.skillSha256 !== first.metadata.skillSha256
        || run.metadata.guidanceSha256 !== reference.metadata.guidanceSha256
        || run.metadata.instructionsSha256 !== reference.metadata.instructionsSha256
        || (run.observedModel !== undefined && run.observedModel !== first.metadata.model)) {
        throw new Error("Mixed variants, models, or skill/guidance snapshots cannot be compared.");
      }
    }
    for (const task of TASKS) {
      const samples = runs.filter((run) => run.task === task);
      const baseline = before.find((run) => run.task === task);
      if (samples.length !== 3 || samples.some((run) => run.metadata.taskSha256 !== baseline?.metadata.taskSha256)) {
        throw new Error("Task sets, repetitions, and fixture hashes must match.");
      }
    }
  }
  const count = (runs: Run[]) => runs.filter((run) => run.status === "passed").length;
  const summarize = (runs: Run[]) => ({
    passed: count(runs),
    runs: runs.length,
    passRate: count(runs) / runs.length,
    meanSeconds: runs.reduce((sum, run) => sum + run.duration, 0) / runs.length,
    meanTokens: runs.every((run) => run.usage !== null)
      ? runs.reduce((sum, run) => sum + run.usage!.inputTokens + run.usage!.outputTokens, 0) / runs.length : null,
  });
  const tasks = TASKS.map((task) => ({
    task, before: summarize(before.filter((run) => run.task === task)),
    after: summarize(after.filter((run) => run.task === task)),
  }));
  return {
    model: first.metadata.model,
    observedModelVerified: [...before, ...after].every((run) => run.observedModel === first.metadata.model),
    skillSha256: first.metadata.skillSha256,
    before: summarize(before),
    after: summarize(after),
    regressions: tasks.filter((row) => row.after.passed < row.before.passed).map((row) => row.task),
    tasks,
    note: "Exploratory sample, not statistical proof. Inspect failed transcripts for infrastructure errors. Missing usage is null; cached input is included in inputTokens, not added again.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: bun skill-ab/report.ts <before-timestamp-dir> <after-timestamp-dir>");
    console.log(JSON.stringify(compareRuns(readRuns(process.argv[2]!), readRuns(process.argv[3]!)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
