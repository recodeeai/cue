import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRealAgentBin } from "../../../src/lib/claude-binary.js";
import { loadExperiment, TASKS } from "./experiment.js";

type Config = ReturnType<typeof loadExperiment>;
type CommandResult = { code: number; stdout: string; stderr: string };
const root = fileURLToPath(new URL(".", import.meta.url));

// Reuse the CLI's own login in place. Never copy, parse, or log auth.json.
// Drop API credentials, nested Cue/OMX hooks, and NODE_OPTIONS from child env.
export function localEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "HOME", "CODEX_HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  timeout = 30_000, input = "", outputFile?: string): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    // Codex's Linux sandbox can silently drop stdout on Node-created pipe sockets.
    // A regular file descriptor preserves TAP output without weakening the sandbox.
    const outputFd = outputFile ? openSync(outputFile, "w", 0o600) : undefined;
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", outputFd ?? "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => stop("Command timed out; evaluation aborted."), timeout);
    child.stdout?.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
      if (stdout.length + stderr.length > 8_000_000) stop("Command output exceeded the evaluation limit.");
    });
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
      if (stdout.length + stderr.length > 8_000_000) stop("Command output exceeded the evaluation limit.");
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (outputFd !== undefined) closeSync(outputFd);
      if (outputFile) {
        if (lstatSync(outputFile).size > 8_000_000) failure ??= new Error("Grader output exceeded the evaluation limit.");
        else stdout = readFileSync(outputFile, "utf8");
      }
      if (failure) reject(failure);
      else resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on("error", () => { /* early process exit is handled above */ });
    child.stdin?.end(input);
  });
}

// Copy only known fixture paths as regular files, never model-created symlinks.
function copyFixture(source: string, target: string, template = source, relative = "") {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(join(template, relative), { withFileTypes: true })) {
    if (["EVAL.ts", "node_modules", ".git"].includes(entry.name)) continue;
    const path = join(relative, entry.name);
    const stat = lstatSync(join(source, path));
    if (stat.isSymbolicLink()) throw new Error("Fixture symlinks are not permitted.");
    if (entry.isDirectory()) copyFixture(source, join(target, entry.name), template, path);
    else {
      if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Invalid fixture file.");
      writeFileSync(join(target, entry.name), readFileSync(join(source, path)));
    }
  }
}

export async function runLocal(options: {
  codex: string; configs: readonly [Config, Config]; outputRoot: string; smoke: boolean;
}) {
  if (process.platform === "win32") throw new Error("Local evaluation currently requires Linux or macOS.");
  const env = localEnvironment(process.env);
  const auth = await command(options.codex, ["login", "status"], root, env);
  if (auth.code !== 0 || !/Logged in using ChatGPT/.test(auth.stdout + auth.stderr)) {
    throw new Error("Sign in to Codex with ChatGPT first (codex login). API-key auth is not used.");
  }
  const version = await command(options.codex, ["--version"], root, env);
  if (version.code !== 0) throw new Error("Unable to determine the local Codex version.");
  const executionSha256 = createHash("sha256").update(JSON.stringify({
    runner: "codex-local-v1", version: version.stdout.trim(),
    source: readFileSync(fileURLToPath(import.meta.url), "utf8"),
    sandbox: "workspace-write", reasoning: "medium", grader: "node:test",
  })).digest("hex");
  mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  const tasks = options.smoke ? TASKS.slice(0, 1) : TASKS;
  const repetitions = options.smoke ? 1 : 3;
  let failures = 0;
  // Alternate arm order by repetition to reduce always-running-one-arm-first bias.
  for (const task of tasks) {
    for (let run = 1; run <= repetitions; run++) {
      for (const index of run % 2 ? [0, 1] : [1, 0]) {
        const variant = index === 0 ? "before" : "after", config = options.configs[index]!;
        if (typeof config.model !== "string") throw new Error("One explicit model is required.");
        const resultDir = join(options.outputRoot, variant, task, `run-${run}`);
        mkdirSync(resultDir, { recursive: true });
        const scratch = mkdtempSync(join(tmpdir(), "cue-codex-eval-"));
        const workspace = join(scratch, "workspace"), grade = join(scratch, "grade"), home = join(scratch, "home");
        const fixture = join(root, "evals", task);
        try {
          copyFixture(fixture, workspace);
          mkdirSync(home);
          let instructions = "";
          await config.setup!({ writeFiles: async (files: Record<string, string>) => {
            instructions = files["AGENTS.md"] ?? "";
          } } as Parameters<NonNullable<Config["setup"]>>[0]);
          if (!instructions) throw new Error("Missing experiment instructions.");
          const started = Date.now();
          const agent = await command(options.codex, [
            "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
            "--sandbox", "workspace-write", "-c", 'approval_policy="never"',
            "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="medium"',
            "-c", `developer_instructions=${JSON.stringify(instructions)}`,
            "--model", config.model!, "--json", "-C", workspace, "-",
          ], workspace, env, (config.timeout ?? 300) * 1000, readFileSync(join(fixture, "PROMPT.md"), "utf8"));
          const duration = (Date.now() - started) / 1000;
          writeFileSync(join(resultDir, "transcript.jsonl"), agent.stdout, { mode: 0o600 });
          writeFileSync(join(resultDir, "stderr.log"), agent.stderr, { mode: 0o600 });
          const events = agent.stdout.split("\n").flatMap((line) => {
            try { return [JSON.parse(line)]; } catch { return []; }
          });
          if (agent.code !== 0 || !events.some((event) => event?.type === "turn.completed")
            || events.some((event) => ["turn.failed", "error"].includes(event?.type))) {
            throw new Error(`Codex did not complete ${variant}/${task}/${run}; inspect private logs in ${resultDir}.`);
          }
          copyFixture(workspace, grade, fixture);
          // The original hidden grader is introduced only after the agent exits.
          writeFileSync(join(grade, "acceptance.mjs"),
            readFileSync(join(fixture, "EVAL.ts"), "utf8").replace('from "vitest"', 'from "node:test"'));
          const grader = await command(options.codex, [
            "sandbox", "-P", ":read-only", "-C", grade, "--", "node", "--test", "acceptance.mjs", "checks.mjs",
          ], grade, { PATH: env.PATH, HOME: home, CODEX_HOME: home }, 30_000, "", join(resultDir, "grader.tap"));
          writeFileSync(join(resultDir, "grader.log"), grader.stdout + grader.stderr, { mode: 0o600 });
          if (!grader.stdout.includes("TAP version 13")) throw new Error("Grader sandbox failed to start.");
          const status = grader.code === 0 ? "passed" : "failed";
          if (status === "failed") failures++;
          const annotated = await config.onRunComplete!({
            fixture: { name: task },
            runData: { result: { status, duration }, transcript: agent.stdout },
          } as Parameters<NonNullable<Config["onRunComplete"]>>[0]);
          const result = annotated!.result;
          const provenance = result.metadata!.cueSkillAb as Record<string, unknown>;
          result.metadata!.cueSkillAb = { ...provenance, executionSha256, runner: "codex-local", codexVersion: version.stdout.trim() };
          writeFileSync(join(resultDir, "result.json"), JSON.stringify(result, null, 2));
          console.log(`${variant}/${task}/${run}: ${status} (${duration.toFixed(1)}s)`);
        } catch (error) {
          writeFileSync(join(dirname(resultDir), "summary.json"), JSON.stringify({ totalRuns: run, valid: false }));
          throw error;
        } finally { rmSync(scratch, { recursive: true, force: true }); }
      }
    }
    for (const variant of ["before", "after"]) {
      writeFileSync(join(options.outputRoot, variant, task, "summary.json"), JSON.stringify({ totalRuns: repetitions, valid: true }));
    }
  }
  console.log(`Results: ${options.outputRoot}`);
  if (failures) throw new Error(`${failures} graded run(s) failed. Results remain available for comparison.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !["--dry", "--smoke", "--full"].includes(mode!)) {
      throw new Error("Usage: bun skill-ab/local.ts --dry|--smoke|--full");
    }
    const configs = [loadExperiment("before"), loadExperiment("after")] as const;
    if (mode === "--dry") {
      console.log(JSON.stringify({ runner: "codex-local", model: configs[0].model, tasks: TASKS, variants: ["before", "after"], runsPerTask: 3, totalRuns: 30, auth: "existing ChatGPT CLI login", modelCalls: 0 }, null, 2));
    } else {
      const codex = findRealAgentBin("codex");
      if (!codex) throw new Error("Install and sign in to the Codex CLI first.");
      await runLocal({ codex, configs, smoke: mode === "--smoke",
        outputRoot: join(root, "results", "codex-local", new Date().toISOString().replace(/[:.]/g, "-")) });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
