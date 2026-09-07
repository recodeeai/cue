/**
 * E2e coverage for the launch EXEC HANDOFF — the lines that decide whether
 * `claude`/`codex` actually starts with the right env. Uses `--dry-run` (which
 * builds childEnv + the exec plan and prints it as JSON without exec'ing) and a
 * direct recursion-guard probe.
 *
 * Kept in its own file (not launch.e2e.test.ts) to stay additive while that
 * file is being edited concurrently.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../lib/profile-loader";
import { cacheKey } from "../lib/resolver-npx";

const CUE_BIN = join(import.meta.dir, "../index.ts");
const BUN_SPAWNABLE = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
// `resources/skills` is a git submodule; even `--dry-run` materializes a runtime
// that symlinks skills, so the exec-handoff probes exit non-zero without it
// checked out (`git submodule update --init`). Skip rather than fail spuriously.
// The help/recursion probes below don't materialize, so they stay on.
const SKILLS_PRESENT = existsSync(join(import.meta.dir, "../../resources/skills/skills"));

async function seedCoreNpxCache(cacheHome: string): Promise<void> {
  // Ponytail inherits core and supplies the implicit Codex launch defaults.
  const profile = await loadProfile("ponytail");
  for (const entry of profile.skills.npx) {
    const slot = join(cacheHome, "cue", "npx", cacheKey(entry.repo, entry.pin));
    for (const skill of entry.skills) {
      const skillDir = join(slot, skill);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }
  }
}

function cue(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.CUE_LAUNCHING;
  delete cleanEnv.CLAUDE_CONFIG_DIR;
  const res = spawnSync("bun", ["run", CUE_BIN, ...args], { encoding: "utf8", timeout: 20000, env: cleanEnv });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function plan(stdout: string): any {
  return JSON.parse(stdout.match(/\{[\s\S]*\}/)![0]);
}

describe.skipIf(!BUN_SPAWNABLE || !SKILLS_PRESENT)("cue launch --dry-run exec handoff", () => {
  let xdg: string;
  beforeEach(async () => {
    xdg = await mkdtemp(join(tmpdir(), "cue-handoff-"));
    await seedCoreNpxCache(join(xdg, "cache"));
  });
  afterEach(async () => {
    await rm(xdg, { recursive: true, force: true });
  });

  test("claude → CLAUDE_CONFIG_DIR points at the materialized runtime", () => {
    const r = cue(["launch", "claude", "--cue-profile", "core", "--dry-run"], {
      XDG_CONFIG_HOME: xdg,
      XDG_CACHE_HOME: join(xdg, "cache"),
    });
    expect(r.status).toBe(0);
    const p = plan(r.stdout);
    const expected = join(xdg, "cue", "runtime", "core", "claude");
    expect(p.agent).toBe("claude-code");
    expect(p.env.CLAUDE_CONFIG_DIR).toBe(expected);
    expect(p.runtimeDir).toBe(expected);
    expect(p.command).toEqual(["claude"]);
    expect(p.env.CODEX_HOME).toBeUndefined();
    expect(existsSync(join(expected, "skills", "ponytail"))).toBe(false);
    // NOTE: CUE_LAUNCHING is intentionally absent from the dry-run JSON (only
    // env[envKey] is serialized); it's covered by the recursion-guard test.
  });

  test("codex → CODEX_HOME stays on the selected profile with Ponytail enabled", async () => {
    const persistentCodexHome = join(xdg, "persistent-codex");
    const r = cue(["launch", "codex", "--cue-profile", "core", "--dry-run"], {
      XDG_CONFIG_HOME: xdg,
      XDG_CACHE_HOME: join(xdg, "cache"),
      CODEX_HOME: persistentCodexHome,
    });
    expect(r.status).toBe(0);
    const p = plan(r.stdout);
    const expected = join(xdg, "cue", "runtime", "core", "codex");
    expect(p.agent).toBe("codex");
    expect(p.env.CODEX_HOME).toBe(expected);
    expect(p.env.CUE_CANONICAL_CODEX_HOME).toBe(persistentCodexHome);
    expect(p.command).toEqual(["codex"]);
    expect(p.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    for (const skill of ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"]) {
      expect(existsSync(join(expected, "skills", skill, "SKILL.md"))).toBe(true);
    }
    const guidance = await readFile(join(expected, "AGENTS.md"), "utf8");
    expect(guidance.match(/Use the ponytail skill for coding tasks/g)).toHaveLength(1);
  });

  test("passthrough args flow into the exec command", () => {
    const r = cue(["launch", "claude", "--cue-profile", "core", "--dry-run", "--resume", "foo"], {
      XDG_CONFIG_HOME: xdg,
      XDG_CACHE_HOME: join(xdg, "cache"),
    });
    expect(r.status).toBe(0);
    const p = plan(r.stdout);
    expect(p.command).toEqual(["claude", "--resume", "foo"]);
  });
});

describe.skipIf(!BUN_SPAWNABLE)("cue launch help passthrough", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cue-help-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("agent --help bypasses runtime materialization", async () => {
    const binDir = join(tmp, "bin");
    await mkdir(binDir);
    const fakeClaude = join(binDir, "claude");
    await writeFile(fakeClaude, "#!/usr/bin/env sh\necho fake-claude-help \"$@\"\nexit 42\n");
    await chmod(fakeClaude, 0o755);

    const blockedXdg = join(tmp, "xdg-file");
    await writeFile(blockedXdg, "not a directory\n");
    const r = cue(["launch", "claude", "--help"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: blockedXdg,
    });

    expect(r.status).toBe(42);
    expect(r.stdout).toContain("fake-claude-help --help");
    expect(r.stderr).not.toContain("materialize");
    expect(r.stderr).not.toContain("ENOTDIR");
  });
});

describe.skipIf(!BUN_SPAWNABLE)("cue launch recursion guard", () => {
  let xdg: string;
  beforeEach(async () => {
    xdg = await mkdtemp(join(tmpdir(), "cue-recursion-"));
    await seedCoreNpxCache(join(xdg, "cache"));
  });
  afterEach(async () => {
    await rm(xdg, { recursive: true, force: true });
  });
  // Must NOT use the cue() helper — it strips CUE_LAUNCHING. Spawn directly
  // with the depth set (and CLAUDE_CONFIG_DIR cleared to avoid the unrelated
  // account-alias → picker path).
  const launchAtDepth = (depth: string) => {
    const env = {
      ...process.env,
      CUE_LAUNCHING: depth,
      XDG_CONFIG_HOME: xdg,
      XDG_CACHE_HOME: join(xdg, "cache"),
    };
    delete env.CLAUDE_CONFIG_DIR;
    return spawnSync("bun", ["run", CUE_BIN, "launch", "claude", "--cue-profile", "core", "--dry-run"], {
      encoding: "utf8",
      timeout: 15000,
      env,
    });
  };

  test("aborts with exit 2 once nesting reaches the cap", () => {
    const res = launchAtDepth("3");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to go further");
  });

  // The case that made the counter necessary: an agent, or a tool it runs,
  // invoking `claude` for a subtask — an AI code review, say. That is one level
  // of honest nesting and must not be mistaken for a shim loop.
  test("a single nested launch is allowed", () => {
    const res = launchAtDepth("1");
    expect(res.status).not.toBe(2);
    expect(res.stderr).not.toContain("refusing to go further");
  });

  // Pre-counter cue wrote the literal "1"; it must keep meaning depth 1.
  test("a non-numeric marker from an older cue reads as depth 1", () => {
    const res = launchAtDepth("yes");
    expect(res.status).not.toBe(2);
  });
});
