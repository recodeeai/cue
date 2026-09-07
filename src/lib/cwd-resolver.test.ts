import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProfileForCwd, resolveActiveProfile } from "./cwd-resolver";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cue-resolver-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveProfileForCwd", () => {
  test("returns null when nothing pinned and no defaults set", async () => {
    const out = await resolveProfileForCwd({
      cwd: root,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "none" });
  });

  test("reads .cue.profile in cwd", async () => {
    await writeFile(join(root, ".cue.profile"), "frontend\n");
    const out = await resolveProfileForCwd({
      cwd: root,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "pin-file", profile: "frontend", pinPath: join(root, ".cue.profile") });
  });

  test("walks up to find .cue.profile", async () => {
    await writeFile(join(root, ".cue.profile"), "backend\n");
    const child = join(root, "a", "b", "c");
    await mkdir(child, { recursive: true });
    const out = await resolveProfileForCwd({
      cwd: child,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "pin-file", profile: "backend", pinPath: join(root, ".cue.profile") });
  });

  test("stops walking at homeDir", async () => {
    await writeFile(join(root, ".cue.profile"), "should-not-find");
    const home = join(root, "home");
    const child = join(home, "user");
    await mkdir(child, { recursive: true });
    const out = await resolveProfileForCwd({
      cwd: child,
      homeDir: home,
      configDir: join(home, ".config", "cue"),
    });
    expect(out.source).toBe("none");
  });

  test("falls back to repo-defaults.json keyed by git repo root", async () => {
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(root, ".config", "cue"), { recursive: true });
    await writeFile(
      join(root, ".config", "cue", "repo-defaults.json"),
      JSON.stringify({ [repo]: "research" }),
    );
    const out = await resolveProfileForCwd({
      cwd: repo,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "repo-default", profile: "research" });
  });

  test.each(["directory", "worktree-file"])("does not inherit a pin above a Git %s", async (kind) => {
    const repo = join(root, "repo");
    const cwd = join(repo, "src");
    const configDir = join(root, "config");
    await mkdir(cwd, { recursive: true });
    await mkdir(configDir);
    if (kind === "directory") await mkdir(join(repo, ".git"));
    else await writeFile(join(repo, ".git"), "gitdir: /unused/worktree\n");
    await writeFile(join(root, ".cue.profile"), "wrong-parent");
    await writeFile(join(configDir, "repo-defaults.json"), JSON.stringify({ [repo]: "research" }));
    expect(await resolveProfileForCwd({ cwd, homeDir: root, configDir }))
      .toEqual({ source: "repo-default", profile: "research" });
    await writeFile(join(repo, ".cue.profile"), "backend\n");
    expect(await resolveProfileForCwd({ cwd, homeDir: root, configDir }))
      .toEqual({ source: "pin-file", profile: "backend", pinPath: join(repo, ".cue.profile") });
  });

  test.each([null, true, 42, {}, [], "", "   "].map((value) => ({ value })))("ignores invalid repo-default value %j", async ({ value }) => {
    const configDir = join(root, "config");
    await mkdir(join(root, ".git"));
    await mkdir(configDir);
    await writeFile(join(configDir, "repo-defaults.json"), JSON.stringify({ [root]: value }));
    await writeFile(join(configDir, "default-profile"), "core\n");
    expect(await resolveProfileForCwd({ cwd: root, homeDir: root, configDir }))
      .toEqual({ source: "global-default", profile: "core" });
  });

  test("falls back to default-profile file", async () => {
    await mkdir(join(root, ".config", "cue"), { recursive: true });
    await writeFile(join(root, ".config", "cue", "default-profile"), "core\n");
    const out = await resolveProfileForCwd({
      cwd: root,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "global-default", profile: "core" });
  });

  test("composes multi-line default-profile into a core+ selector", async () => {
    await mkdir(join(root, ".config", "cue"), { recursive: true });
    await writeFile(
      join(root, ".config", "cue", "default-profile"),
      "core\nskill-writer\n",
    );
    const out = await resolveProfileForCwd({
      cwd: root,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
    });
    expect(out).toEqual({ source: "global-default", profile: "core+skill-writer" });
  });

  test("--cue-profile flag (passed via override) wins over everything", async () => {
    await writeFile(join(root, ".cue.profile"), "frontend");
    const out = await resolveProfileForCwd({
      cwd: root,
      homeDir: root,
      configDir: join(root, ".config", "cue"),
      override: "backend",
    });
    expect(out).toEqual({ source: "flag", profile: "backend" });
  });
});

describe("resolveActiveProfile (convenience wrapper)", () => {
  test("composes the global-default composition into a selector string", async () => {
    const cfg = join(root, ".config", "cue");
    await mkdir(cfg, { recursive: true });
    await writeFile(join(cfg, "default-profile"), "core\nskill-writer\n");
    const cleanCwd = join(root, "work");
    await mkdir(cleanCwd, { recursive: true });

    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, ".config");
    try {
      expect(await resolveActiveProfile(cleanCwd)).toBe("core+skill-writer");
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  test("returns null when no profile applies", async () => {
    const cleanCwd = join(root, "work");
    await mkdir(cleanCwd, { recursive: true });

    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, ".config"); // empty — no default-profile
    try {
      expect(await resolveActiveProfile(cleanCwd)).toBeNull();
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});

// Regression guard for the signature-drift class: resolveProfileForCwd takes
// an options object and returns a ResolveResult. A bare string argument (the
// old contract) silently breaks active-profile detection. Commands should use
// resolveActiveProfile() or pass the options object — never a string.
describe("no command misuses resolveProfileForCwd", () => {
  test("no command calls resolveProfileForCwd with a non-object argument", async () => {
    const commandsDir = join(import.meta.dir, "..", "commands");
    const files = (await readdir(commandsDir)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(join(commandsDir, file), "utf8");
      // Match resolveProfileForCwd( not immediately followed by `{` (the
      // options object). Allows whitespace/newline before the brace.
      const re = /resolveProfileForCwd\(\s*(?!\{)/g;
      if (re.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
