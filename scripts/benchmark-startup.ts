/** Offline launch benchmark: real CLI + backend profile, disposable home, stub agent.
 * Run: bun scripts/benchmark-startup.ts
 * Measures Cue only, not model/MCP startup or network downloads.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../src/lib/profile-loader";
import { cacheKey } from "../src/lib/resolver-npx";

const repo = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "cue-startup-bench-"));
try {
  const home = join(scratch, "home");
  const cwd = join(home, "project");
  const config = join(scratch, "config");
  const cache = join(scratch, "cache");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, ".cue.profile"), "backend\n");
  const agent = join(scratch, "agent");
  await writeFile(agent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.CUE_REPO_ROOT = repo;
  process.env.CUE_PROFILES_DIR = join(repo, "profiles");
  // Seed only disposable remote skill fixtures; never download or use credentials.
  for (const name of ["backend", "ponytail"]) {
    const profile = await loadProfile(name);
    for (const entry of profile.skills.npx) {
      for (const skill of entry.skills) {
        const dir = join(cache, "cue", "npx", cacheKey(entry.repo, entry.pin), skill);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `# ${skill}\n`);
      }
    }
  }
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    CODEX_HOME: join(home, ".codex"),
    CUE_PROFILES_DIR: join(repo, "profiles"),
    CUE_REAL_CODEX: agent,
    CI: "1",
  };
  const launch = (): number => {
    const start = performance.now();
    const result = spawnSync("bash", [join(repo, "bin/cue"), "launch", "codex", "--cue-profile", "backend", "--cue-full"], {
      cwd, env, encoding: "utf8", timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return performance.now() - start;
  };
  launch();
  for (const cold of [false, true]) {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (cold) await rm(join(config, "cue", "runtime"), { recursive: true, force: true });
      samples.push(launch());
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(JSON.stringify({
      scenario: cold ? "backend-cold-runtime" : "backend-warm-runtime",
      runs: samples.length,
      medianMs: Math.round(sorted[3]!),
      minMs: Math.round(sorted[0]!),
      maxMs: Math.round(sorted[6]!),
      samplesMs: samples.map(Math.round),
    }));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
