import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  lstat,
  rm,
  readlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { utimes } from "node:fs/promises";

import {
  materializeRuntime,
  linkPluginCache,
  isRuntimeStale,
  shouldIncludeSessionTelemetry,
  getLastSessionSummary,
  getSkillChains,
} from "./runtime-materializer";
import { MAX_STAGGER_MS } from "./credentials-sync";
import type { ResolvedProfile } from "../../profiles/_types";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cue-runtime-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sampleProfile: ResolvedProfile = {
  name: "test-frontend",
  description: "test",
  agents: ["claude-code"],
  skills: {
    local: [{ id: "design/ui-ux-pro-max" }],
    npx: [],
  },
  mcps: [{ id: "claude-mem" }],
  plugins: [{ id: "frontend-design@claude-plugins-official" }],
  env: {},
  inheritanceChain: ["test-frontend"],
};

describe("materializeRuntime", () => {
  test("materializes the CodeGraph auto-init policy for Claude and Codex", async () => {
    const profile = {
      ...sampleProfile,
      name: "test-codegraph-auto-init",
      agents: ["claude-code", "codex"],
      skills: { local: [], npx: [] },
      mcps: [{ id: "codegraph" }],
      personaIncludes: ["codegraph-routing"],
      inheritanceChain: ["test-codegraph-auto-init"],
    } as unknown as ResolvedProfile;

    for (const agent of ["claude-code", "codex"] as const) {
      const out = await materializeRuntime({
        profile,
        agent,
        runtimeRoot: join(root, "runtime"),
        skillSourceLookup: async (id) => `/fake/skills/${id}`,
        mcpRegistry: {
          codegraph: { command: "codegraph", args: ["serve", "--mcp"] },
        },
        userClaudeMd: "",
      });
      const memoryFile = agent === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
      const content = await readFile(join(out.runtimeDir, memoryFile), "utf8");

      expect(content).toContain("`codegraph init -i`");
      expect(content).toContain("retry the CodeGraph call once");
    }
  });

  test("re-materializes when an included persona changes", async () => {
    const personaPath = join(root, "shared-persona.md");
    await writeFile(personaPath, "first persona policy\n");
    const profile = {
      ...sampleProfile,
      name: "test-persona-content-hash",
      skills: { local: [], npx: [] },
      mcps: [],
      plugins: [],
      personaIncludes: [personaPath, personaPath],
      inheritanceChain: ["test-persona-content-hash"],
    } as unknown as ResolvedProfile;
    const input = {
      profile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    };

    const first = await materializeRuntime(input);
    expect(first.rebuilt).toBe(true);
    expect((await readFile(join(first.runtimeDir, "CLAUDE.md"), "utf8")).split("first persona policy")).toHaveLength(2);
    await writeFile(personaPath, "second persona policy\n");

    const second = await materializeRuntime(input);
    expect(second.rebuilt).toBe(true);
    expect(
      await readFile(join(second.runtimeDir, "CLAUDE.md"), "utf8"),
    ).toContain("second persona policy");
  });

  test("shortens oversized composite profile names to a stable runtime key", async () => {
    const profile = {
      ...sampleProfile,
      name: `medusa-next+${"aas-development-functional-typescript+".repeat(8)}`,
      skills: { local: [], npx: [] },
      mcps: [],
      plugins: [],
      inheritanceChain: [],
    } as ResolvedProfile;
    const input = {
      profile,
      agent: "codex" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    };

    const first = await materializeRuntime(input);
    const second = await materializeRuntime(input);
    const runtimeKey = basename(dirname(first.runtimeDir));

    expect(Buffer.byteLength(runtimeKey)).toBeLessThanOrEqual(120);
    expect(runtimeKey).not.toBe(profile.name);
    expect(second.runtimeDir).toBe(first.runtimeDir);
    expect(second.rebuilt).toBe(false);
  });

  test("codex renders MCP env maps as TOML inline tables", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-codex-mcp-env",
      agents: ["codex"],
      mcps: [{ id: "google-ads-mcp" }],
      inheritanceChain: ["test-codex-mcp-env"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "codex",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: {
        "google-ads-mcp": {
          command: "pipx",
          args: ["run", "google-ads-mcp"],
          env: {
            GOOGLE_PROJECT_ID: "my-project",
            GOOGLE_ADS_DEVELOPER_TOKEN: "secret",
          },
        },
      },
      userClaudeMd: "",
    });

    const toml = await readFile(join(out.runtimeDir, "config.toml"), "utf8");
    expect(toml).toContain(
      'env = { "GOOGLE_PROJECT_ID" = "my-project", "GOOGLE_ADS_DEVELOPER_TOKEN" = "secret" }',
    );
    expect(toml).not.toContain('"GOOGLE_PROJECT_ID":"my-project"');
  });

  test("codex rebuilds when the effective MCP registry changes", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-codex-mcp-registry-hash",
      agents: ["codex"],
      mcps: [{ id: "codegraph" }],
      inheritanceChain: ["test-codex-mcp-registry-hash"],
    };
    const input = {
      profile,
      agent: "codex" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {
        codegraph: { command: "codegraph-v1", args: ["serve", "--mcp"] },
      },
      userClaudeMd: "",
    };

    await materializeRuntime(input);
    const second = await materializeRuntime({
      ...input,
      mcpRegistry: {
        codegraph: { command: "codegraph-v2", args: ["serve", "--mcp"] },
      },
    });

    expect(second.rebuilt).toBe(true);
    expect(
      await readFile(join(second.runtimeDir, "config.toml"), "utf8"),
    ).toContain('command = "codegraph-v2"');
  });

  test("codex config.toml inherits the base config and applies profile overrides", async () => {
    const base = join(root, "base-config.toml");
    await writeFile(
      base,
      [
        'model = "gpt-5.5"',
        'model_reasoning_effort = "xhigh"',
        "model_auto_compact_token_limit = 320000",
        'sandbox_mode = "danger-full-access"',
        "",
        "[features]",
        "goals = true",
        "memories = true",
        "",
        "[mcp_servers.from-base]",
        'command = "nope"',
      ].join("\n"),
    );

    const profile = {
      ...sampleProfile,
      name: "test-codex-inherit",
      agents: ["codex"] as ResolvedProfile["agents"],
      mcps: [{ id: "google-ads-mcp" }],
      inheritanceChain: ["test-codex-inherit"],
      codex: { sandbox_mode: "workspace-write", features: { memories: false } },
    } as ResolvedProfile;

    const out = await materializeRuntime({
      profile,
      agent: "codex",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: {
        "google-ads-mcp": { command: "pipx", args: ["run", "google-ads-mcp"] },
      },
      userClaudeMd: "",
      codexBaseConfig: base,
    });

    const toml = await readFile(join(out.runtimeDir, "config.toml"), "utf8");
    // inherited — these are what keep a Codex session working as long as configured
    expect(toml).toContain('model_reasoning_effort = "xhigh"');
    expect(toml).toContain("model_auto_compact_token_limit = 320000");
    expect(toml).toContain("goals = true");
    // profile overrides win, key by key
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).not.toContain("danger-full-access");
    expect(toml).toContain("memories = false");
    // cue keeps owning MCP wiring
    expect(toml).toContain("[mcp_servers.google-ads-mcp]");
    expect(toml).not.toContain("[mcp_servers.from-base]");
    // TOML requires top-level keys before any table header
    expect(toml.indexOf('model = "gpt-5.5"')).toBeLessThan(toml.indexOf("["));
  });

  test("codex runtime disables external skills and re-enables profile skills", async () => {
    const base = join(root, "base-config.toml");
    await writeFile(
      base,
      '[[skills.config]]\nname = "ui-ux-pro-max"\nenabled = false\n',
    );
    const external = "/repo/.agents/skills/unrelated/SKILL.md";
    const out = await materializeRuntime({
      profile: {
        ...sampleProfile,
        name: "test-codex-skill-scope",
        agents: ["codex"],
        inheritanceChain: ["test-codex-skill-scope"],
      },
      agent: "codex",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
      codexBaseConfig: base,
      codexExternalSkillPaths: [external],
    });

    const toml = await readFile(join(out.runtimeDir, "config.toml"), "utf8");
    const inherited = toml.indexOf('name = "ui-ux-pro-max"');
    const disabled = toml.indexOf(`path = "${external}"`);
    const enabledPath = join(
      out.runtimeDir,
      "skills",
      "ui-ux-pro-max",
      "SKILL.md",
    );
    const enabled = toml.indexOf(`path = "${enabledPath}"`);
    expect(inherited).toBeGreaterThan(-1);
    expect(disabled).toBeGreaterThan(inherited);
    expect(enabled).toBeGreaterThan(disabled);
    expect(toml.slice(disabled, enabled)).toContain("enabled = false");
    expect(toml.slice(enabled)).toContain("enabled = true");
  });

  test("legacy codex_config still lands in config.toml", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-codex-config",
      agents: ["codex"],
      mcps: [{ id: "google-ads-mcp" }],
      codexConfig: {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        sandbox_workspace_write: {
          writable_roots: ["/home/u/.local/share/ego-lite-linux"],
          network_access: true,
        },
      },
      inheritanceChain: ["test-codex-config"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "codex",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: {
        "google-ads-mcp": { command: "pipx", args: ["run", "google-ads-mcp"] },
      },
      userClaudeMd: "",
    });

    const toml = await readFile(join(out.runtimeDir, "config.toml"), "utf8");
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain(
      'sandbox_workspace_write = { "writable_roots" = ["/home/u/.local/share/ego-lite-linux"], "network_access" = true }',
    );
    expect(toml.indexOf('sandbox_mode = "workspace-write"')).toBeLessThan(
      toml.indexOf("[mcp_servers.google-ads-mcp]"),
    );
  });

  test("codex runtime rebuilds when the base config changes", async () => {
    const base = join(root, "base-config.toml");
    await writeFile(base, 'model_reasoning_effort = "low"\n');
    const profile = {
      ...sampleProfile,
      name: "test-codex-rehash",
      agents: ["codex"] as ResolvedProfile["agents"],
      mcps: [],
      inheritanceChain: ["test-codex-rehash"],
    } as ResolvedProfile;
    const input = {
      profile,
      agent: "codex" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
      codexBaseConfig: base,
    };

    const first = await materializeRuntime(input);
    const firstHash = (
      await readFile(join(first.runtimeDir, ".cue-hash"), "utf8")
    ).trim();

    await writeFile(base, 'model_reasoning_effort = "xhigh"\n');
    const second = await materializeRuntime(input);
    const secondHash = (
      await readFile(join(second.runtimeDir, ".cue-hash"), "utf8")
    ).trim();

    expect(secondHash).not.toBe(firstHash);
    expect(
      await readFile(join(second.runtimeDir, "config.toml"), "utf8"),
    ).toContain('model_reasoning_effort = "xhigh"');
  });

  test("creates runtime dir with hash and settings.json", async () => {
    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      // tests stub these so we don't need real skills/mcps on disk
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
    });

    expect(out.runtimeDir).toBe(
      join(root, "runtime", "test-frontend", "claude"),
    );
    expect(out.rebuilt).toBe(true);

    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.enabledPlugins).toEqual({
      "frontend-design@claude-plugins-official": true,
    });
    expect(settings.mcpServers).toEqual({
      "claude-mem": { command: "claude-mem", args: [] },
    });

    const claudemd = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    expect(claudemd).toMatch(/^<!-- cue: profile=test-frontend/);
    expect(claudemd).toContain("# user CLAUDE.md");

    const hash = await readFile(join(out.runtimeDir, ".cue-hash"), "utf8");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("project-loadout deferred index: generated skill written, hashed, absent without", async () => {
    const opts = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "",
    };
    const withDeferred: ResolvedProfile = {
      ...sampleProfile,
      name: "test-loadout",
      inheritanceChain: ["test-loadout"],
      deferredSkills: [
        {
          id: "gstack/browse",
          description: "Headless browser QA",
          path: "/skills/gstack/browse/SKILL.md",
        },
      ],
    };
    const out = await materializeRuntime({ ...opts, profile: withDeferred });
    const indexPath = join(
      out.runtimeDir,
      "skills",
      "cue-deferred-skills",
      "SKILL.md",
    );
    const index = await readFile(indexPath, "utf8");
    expect(index).toContain("gstack/browse");
    expect(index).toContain("Headless browser QA");
    expect(index).toContain("/skills/gstack/browse/SKILL.md");
    // The generated index is a real file, not a symlink into resources.
    expect(
      (
        await lstat(join(out.runtimeDir, "skills", "cue-deferred-skills"))
      ).isSymbolicLink(),
    ).toBe(false);

    // Same profile without deferredSkills → different hash (rebuild) and no index.
    const bare: ResolvedProfile = { ...withDeferred };
    delete (bare as { deferredSkills?: unknown }).deferredSkills;
    const out2 = await materializeRuntime({ ...opts, profile: bare });
    expect(out2.hash).not.toBe(out.hash);
    await expect(
      stat(join(out2.runtimeDir, "skills", "cue-deferred-skills")),
    ).rejects.toThrow();
  });

  test("codex keeps profile and installed hooks in one JSON representation across rebuilds", async () => {
    const cueHook = { hooks: [{ type: "command", command: "cue handoff hook" }] };
    const omxHook = { hooks: [{ type: "command", command: "omx-hook" }] };
    const profile: ResolvedProfile = {
      ...sampleProfile,
      agents: ["codex"],
      codex: { hooks: { SessionStart: [cueHook], Stop: [cueHook] } },
    };
    const opts = {
      profile,
      agent: "codex" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    };
    const first = await materializeRuntime(opts);
    const hooksPath = join(first.runtimeDir, "hooks.json");
    expect(JSON.parse(await readFile(hooksPath, "utf8")).hooks.SessionStart).toEqual([cueHook]);
    await writeFile(hooksPath, JSON.stringify({
      metadata: "preserve",
      hooks: { SessionStart: [omxHook, cueHook], PreToolUse: [omxHook] },
    }));
    for (const description of ["rebuild once", "rebuild twice"]) {
      await materializeRuntime({ ...opts, profile: { ...profile, description } });
      const config = Bun.TOML.parse(await readFile(join(first.runtimeDir, "config.toml"), "utf8"));
      expect(config.hooks).toBeUndefined();
      expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual({
        metadata: "preserve",
        hooks: { SessionStart: [omxHook, cueHook], PreToolUse: [omxHook], Stop: [cueHook] },
      });
    }
    await materializeRuntime({ ...opts, profile: { ...profile, codex: {} } });
    expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual({
      metadata: "preserve", hooks: { SessionStart: [omxHook], PreToolUse: [omxHook] },
    });
    expect(JSON.parse(await readFile(join(first.runtimeDir, ".cue-hooks.json"), "utf8"))).toEqual({ version: 1, hooks: {} });
    await writeFile(hooksPath, "invalid JSON");
    await expect(materializeRuntime({
      ...opts, profile: { ...profile, description: "invalid hook file" },
    })).rejects.toThrow();
    expect(await readFile(hooksPath, "utf8")).toBe("invalid JSON");
  });

  test("codex rebuild preserves rollout, thread store and exact runtime-local approvals", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-codex-state",
      agents: ["codex"],
      inheritanceChain: ["test-codex-state"],
    };
    const opts = {
      agent: "codex" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    };
    const first = await materializeRuntime({ ...opts, profile });
    const rollout = join(
      first.runtimeDir,
      "sessions",
      "2026",
      "08",
      "10",
      "rollout-thread.jsonl",
    );
    await mkdir(join(rollout, ".."), { recursive: true });
    await writeFile(rollout, '{"type":"response_item"}\n');
    await writeFile(
      join(first.runtimeDir, "thread_history_1.sqlite"),
      "thread-state",
    );
    const state = '[projects."/runtime-only"]\ntrust_level = "trusted"\n\n[hooks.state."approved-hash"]\nenabled = true\n\n[hooks.state."disabled-hash"]\nenabled = false\n';
    await writeFile(join(first.runtimeDir, "config.toml"), 'model = "stale-model"\n' + state);

    const rebuilt = await materializeRuntime({
      ...opts,
      profile: { ...profile, description: "force a new materialization hash" },
    });

    expect(rebuilt.rebuilt).toBe(true);
    const rebuiltConfig = await readFile(join(rebuilt.runtimeDir, "config.toml"), "utf8");
    expect(rebuiltConfig).toContain(state);
    expect(rebuiltConfig).not.toContain("stale-model");
    expect(Bun.TOML.parse(rebuiltConfig).hooks).toEqual({ state: { "approved-hash": { enabled: true }, "disabled-hash": { enabled: false } } });
    const separate = await materializeRuntime({ ...opts, profile: { ...profile, name: "other-runtime" } });
    expect(await readFile(join(separate.runtimeDir, "config.toml"), "utf8")).not.toContain("runtime-only");
    expect(await readFile(rollout, "utf8")).toContain("response_item");
    expect(
      await readFile(
        join(rebuilt.runtimeDir, "thread_history_1.sqlite"),
        "utf8",
      ),
    ).toBe("thread-state");
  });

  test("when: gate — MCP excluded while its env condition fails, included once it passes", async () => {
    const ENV_KEY = "CUE_TEST_GATED_MCP_TOKEN";
    delete process.env[ENV_KEY];
    const gatedProfile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-gated",
      mcps: [{ id: "claude-mem" }, { id: "gated", when: { env: ENV_KEY } }],
      inheritanceChain: ["test-gated"],
    };
    const registry = {
      "claude-mem": { command: "claude-mem", args: [] },
      gated: { command: "gated-server" },
    };
    const opts = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: registry,
      userClaudeMd: "# user CLAUDE.md\n",
    };

    // .claude.json is the file Claude Code reads for mcpServers, and it's
    // re-synced on every launch (cache hit or rebuild), so it reflects the
    // current cwd/env gate even when the profile hash is unchanged.
    const claudeJsonMcps = async (dir: string) =>
      JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"))
        .mcpServers as Record<string, unknown>;

    // Condition fails (env unset): the gated server is absent.
    const off = await materializeRuntime({ profile: gatedProfile, ...opts });
    expect(Object.keys(await claudeJsonMcps(off.runtimeDir))).toEqual([
      "claude-mem",
    ]);
    const offSettings = JSON.parse(
      await readFile(join(off.runtimeDir, "settings.json"), "utf8"),
    );
    expect(Object.keys(offSettings.mcpServers)).toEqual(["claude-mem"]);

    // Condition passes (env set): the gated server activates on the next launch
    // — re-collected even though the profile hash is unchanged (cache hit).
    try {
      process.env[ENV_KEY] = "1";
      const on = await materializeRuntime({ profile: gatedProfile, ...opts });
      expect((await claudeJsonMcps(on.runtimeDir)).gated).toEqual({
        command: "gated-server",
      });
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  test("surfaces allowlisted profile.env (CLAUDE_CODE_SUBAGENT_MODEL) into settings.env", async () => {
    const out = await materializeRuntime({
      profile: {
        ...sampleProfile,
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-6",
          // secret reference — must NOT leak into settings.json
          AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
        },
      },
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
    });

    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.env).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-6",
    });
    // unresolved "${...}" placeholder and non-allowlisted keys stay out
    expect(settings.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("surfaces ANTHROPIC_BASE_URL when the proxy health endpoint responds (health-gate pass)", async () => {
    const port = 43111;
    const out = await materializeRuntime({
      profile: {
        ...sampleProfile,
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
      },
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
      proxyHealthCheck: async () => true,
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    });
  });

  test("drops ANTHROPIC_BASE_URL when the port is open but health does not answer", async () => {
    const port = 43112;
    const out = await materializeRuntime({
      profile: {
        ...sampleProfile,
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
      },
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
      proxyHealthCheck: async () => false,
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("drops ANTHROPIC_BASE_URL when the proxy is unreachable (health-gate fail-open)", async () => {
    const closedPort = 43113;

    const out = await materializeRuntime({
      profile: {
        ...sampleProfile,
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${closedPort}` },
      },
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
      proxyHealthCheck: async () => false,
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    // Fail-open: the unreachable base URL is dropped, so Claude talks to Anthropic directly.
    expect(settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("second call with same profile is a no-op (rebuilt=false)", async () => {
    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
    };
    const first = await materializeRuntime(args);
    expect(first.rebuilt).toBe(true);
    const second = await materializeRuntime(args);
    expect(second.rebuilt).toBe(false);
  });

  test("re-materializes when profile content changes", async () => {
    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
    };
    await materializeRuntime(args);

    const changed: ResolvedProfile = {
      ...sampleProfile,
      plugins: [{ id: "vercel@claude-plugins-official" }],
    };
    const second = await materializeRuntime({ ...args, profile: changed });
    expect(second.rebuilt).toBe(true);
  });

  test("a stale .cue-hash (e.g. from a prior MATERIALIZER_VERSION) forces a rebuild", async () => {
    // Guards the activation guarantee behind the version bump: when the
    // generated output changes but no profile field does, an existing runtime
    // must still rebuild. We simulate a runtime left by older code by writing a
    // hash that can't match the current computation, then assert rebuilt=true.
    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "# user CLAUDE.md\n",
    };
    const first = await materializeRuntime(args);
    expect(first.rebuilt).toBe(true);
    // Stomp the stored hash with a stale value (what a prior version would have left).
    await writeFile(
      join(first.runtimeDir, ".cue-hash"),
      "stale-hash-from-old-version\n",
    );
    const second = await materializeRuntime(args);
    expect(second.rebuilt).toBe(true);
    // And the freshly written hash is the real current one (no longer stale).
    const stored = (
      await readFile(join(first.runtimeDir, ".cue-hash"), "utf8")
    ).trim();
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
  });

  test("symlinks every local skill into <runtime>/skills/", async () => {
    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    // Flat layout (skills/<slug>) so Claude Code's one-level discovery finds it.
    const link = await readlink(
      join(out.runtimeDir, "skills", "ui-ux-pro-max"),
    );
    expect(link).toBe("/fake/source/design/ui-ux-pro-max");
  });

  test("writes a .cue-skills manifest of <category>/<slug> ids for smart-loader", async () => {
    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const manifest = await readFile(
      join(out.runtimeDir, ".cue-skills"),
      "utf8",
    );
    expect(manifest.split("\n").filter(Boolean)).toContain(
      "design/ui-ux-pro-max",
    );
  });

  test("slug collisions resolve last-wins; both ids stay in the manifest", async () => {
    const collide: ResolvedProfile = {
      ...sampleProfile,
      skills: {
        ...sampleProfile.skills,
        local: [{ id: "plan/investigate" }, { id: "gstack/investigate" }],
      },
    };
    const out = await materializeRuntime({
      profile: collide,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    // The later entry (gstack/investigate) wins the flat /investigate link.
    const link = await readlink(join(out.runtimeDir, "skills", "investigate"));
    expect(link).toBe("/fake/source/gstack/investigate");
    // Both remain in the manifest so smart-loader knows the lean one is loaded too.
    const manifest = (
      await readFile(join(out.runtimeDir, ".cue-skills"), "utf8")
    )
      .split("\n")
      .filter(Boolean);
    expect(manifest).toContain("plan/investigate");
    expect(manifest).toContain("gstack/investigate");
  });

  test("excludes resources whose agents list does not include current agent", async () => {
    const filtered: ResolvedProfile = {
      ...sampleProfile,
      mcps: [{ id: "codex-only", agents: ["codex"] }, { id: "claude-mem" }],
    };
    const out = await materializeRuntime({
      profile: filtered,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {
        "codex-only": {},
        "claude-mem": { command: "claude-mem" },
      },
      userClaudeMd: "",
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(Object.keys(settings.mcpServers)).toEqual(["claude-mem"]);
  });

  test("credentialsSource: copies .credentials.json into runtime (token refreshes stay local)", async () => {
    const credSrc = join(root, "creds");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { lstat } = await import("node:fs/promises");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".credentials.json"),
      '{"claudeAiOauth":{"token":"abc"}}',
    );

    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    });

    // Should be a regular file (copy), not a symlink — Claude Code's token
    // refresh does atomic write (tmp → rename) which breaks symlinks.
    const st = await lstat(join(out.runtimeDir, ".credentials.json"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    // Contents match the source
    const contents = await readFile(
      join(out.runtimeDir, ".credentials.json"),
      "utf8",
    );
    expect(contents).toBe('{"claudeAiOauth":{"token":"abc"}}');
  });

  test("credentialsSource: overlays sessions/, projects/, history.jsonl, etc.", async () => {
    const credSrc = join(root, "creds");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { readlink } = await import("node:fs/promises");
    await mkdir(join(credSrc, "sessions"), { recursive: true });
    await mkdir(join(credSrc, "projects"), { recursive: true });
    await writeFile(join(credSrc, "history.jsonl"), '{"sess":1}\n');
    await writeFile(join(credSrc, ".session-stats.json"), '{"x":1}');
    await writeFile(join(credSrc, ".credentials.json"), '{"token":"a"}');
    // cue-managed files in source MUST NOT be symlinked (cue overrides them).
    await writeFile(
      join(credSrc, "settings.json"),
      JSON.stringify({ permissions: { allow: [] } }),
    );

    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    });

    // Source state symlinked through
    expect(await readlink(join(out.runtimeDir, "sessions"))).toBe(
      join(credSrc, "sessions"),
    );
    expect(await readlink(join(out.runtimeDir, "projects"))).toBe(
      join(credSrc, "projects"),
    );
    expect(await readlink(join(out.runtimeDir, "history.jsonl"))).toBe(
      join(credSrc, "history.jsonl"),
    );
    expect(await readlink(join(out.runtimeDir, ".session-stats.json"))).toBe(
      join(credSrc, ".session-stats.json"),
    );

    // .credentials.json is COPIED (not symlinked) because Claude Code's
    // token refresh does atomic write which breaks symlinks.
    const { lstat: lstatCred } = await import("node:fs/promises");
    const credSt = await lstatCred(join(out.runtimeDir, ".credentials.json"));
    expect(credSt.isSymbolicLink()).toBe(false);
    expect(credSt.isFile()).toBe(true);

    // settings.json is cue-managed: NOT a symlink, but a real merged file.
    const { lstat } = await import("node:fs/promises");
    const st = await lstat(join(out.runtimeDir, "settings.json"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
  });

  test("claude rebuild preserves live session-env and task state", async () => {
    const credSrc = join(root, "creds");
    await mkdir(credSrc, { recursive: true });
    const opts = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    };
    const first = await materializeRuntime({ ...opts, profile: sampleProfile });
    await mkdir(join(first.runtimeDir, "session-env", "live-session"), {
      recursive: true,
    });
    await writeFile(
      join(first.runtimeDir, "session-env", "live-session", "env"),
      "ACTIVE=1\n",
    );
    await mkdir(join(first.runtimeDir, "tasks"), { recursive: true });
    await writeFile(
      join(first.runtimeDir, "tasks", "task.json"),
      '{"active":true}\n',
    );

    const rebuilt = await materializeRuntime({
      ...opts,
      profile: { ...sampleProfile, description: "force rebuild" },
    });

    expect(
      await readFile(
        join(rebuilt.runtimeDir, "session-env", "live-session", "env"),
        "utf8",
      ),
    ).toBe("ACTIVE=1\n");
    expect(
      await readFile(join(rebuilt.runtimeDir, "tasks", "task.json"), "utf8"),
    ).toContain("active");
  });

  test("credentialsSource: preserves account-level settings but isolates MCPs + plugins per profile", async () => {
    const credSrc = join(root, "creds");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(*)"], defaultMode: "auto" },
        trustedDirectories: ["/home/user/work"],
        skipAutoPermissionPrompt: true,
        // These two MUST NOT leak into the profile runtime — the profile is
        // the sole source of truth for MCPs + plugins. Otherwise every MCP
        // the user has registered globally appears in EVERY profile, defeating
        // isolation. Pinned by this test (regression: profiles like
        // `cybersecurity` with `mcps: []` were inheriting random user-scoped
        // MCPs like `teherguminet-admin` because of the merge).
        enabledPlugins: { "user-globally-installed@marketplace": true },
        mcpServers: { userGloballyInstalledMcp: { command: "x" } },
      }),
    );

    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    });

    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    // Account-level settings preserved (these are user-scoped, not profile-scoped)
    expect(settings.permissions).toEqual({
      allow: ["Bash(*)"],
      defaultMode: "auto",
    });
    expect(settings.trustedDirectories).toEqual(["/home/user/work"]);
    expect(settings.skipAutoPermissionPrompt).toBe(true);
    // Profile plugins/mcps are EXCLUSIVE — only what the profile declared.
    // The account-level entries from the source settings.json must NOT leak.
    expect(settings.enabledPlugins).toEqual({
      "frontend-design@claude-plugins-official": true,
    });
    expect(settings.mcpServers).toEqual({
      "claude-mem": { command: "claude-mem" },
    });
  });

  test("credentialsSource: refreshes settings on cache hit + repoints symlinks on account switch", async () => {
    const credSrcA = join(root, "credsA");
    const credSrcB = join(root, "credsB");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(credSrcA, { recursive: true });
    await mkdir(credSrcB, { recursive: true });
    await writeFile(join(credSrcA, ".credentials.json"), '{"token":"A"}');
    await writeFile(join(credSrcB, ".credentials.json"), '{"token":"B"}');
    await writeFile(
      join(credSrcA, "settings.json"),
      JSON.stringify({ permissions: { allow: ["A"] } }),
    );
    await writeFile(
      join(credSrcB, "settings.json"),
      JSON.stringify({ permissions: { allow: ["B"] } }),
    );

    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    // First launch with account A → builds runtime with A's creds + settings
    const first = await materializeRuntime({
      ...args,
      credentialsSource: credSrcA,
    });
    expect(first.rebuilt).toBe(true);
    // .credentials.json is a copy, not a symlink
    const contentsA = await readFile(
      join(first.runtimeDir, ".credentials.json"),
      "utf8",
    );
    expect(contentsA).toBe('{"token":"A"}');
    let s1 = JSON.parse(
      await readFile(join(first.runtimeDir, "settings.json"), "utf8"),
    );
    expect(s1.permissions.allow).toEqual(["A"]);

    // Second launch with account B (same profile) → hash matches → cache hit.
    // Settings rebuilt from B; .credentials.json re-copied from B.
    const second = await materializeRuntime({
      ...args,
      credentialsSource: credSrcB,
    });
    expect(second.rebuilt).toBe(false);
    const contentsB = await readFile(
      join(second.runtimeDir, ".credentials.json"),
      "utf8",
    );
    expect(contentsB).toBe('{"token":"B"}');
    let s2 = JSON.parse(
      await readFile(join(second.runtimeDir, "settings.json"), "utf8"),
    );
    expect(s2.permissions.allow).toEqual(["B"]);
  });

  test("credentialsSource: preserves profile-local autoMode on cache hit and rebuild", async () => {
    const credSrc = join(root, "creds");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, "settings.json"),
      JSON.stringify({ permissions: { allow: ["source-before"] } }),
    );

    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    };

    const first = await materializeRuntime(args);
    const settingsPath = join(first.runtimeDir, "settings.json");
    const localAutoMode = {
      environment: ["**Trusted repo**: /work/profile-only"],
    };
    const runtimeSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    runtimeSettings.autoMode = localAutoMode;
    await writeFile(settingsPath, JSON.stringify(runtimeSettings));

    // A cache-hit refresh must still pick up source-owned settings without
    // deleting Claude's profile-local /auto-mode-setup result.
    await writeFile(
      join(credSrc, "settings.json"),
      JSON.stringify({ permissions: { allow: ["source-after"] } }),
    );
    const cached = await materializeRuntime(args);
    expect(cached.rebuilt).toBe(false);
    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.permissions.allow).toEqual(["source-after"]);
    expect(settings.autoMode).toEqual(localAutoMode);

    // A profile change forces an atomic rebuild and must preserve the same
    // profile-local setup rather than falling back to global source settings.
    const rebuilt = await materializeRuntime({
      ...args,
      profile: { ...sampleProfile, description: "force rebuild" },
    });
    expect(rebuilt.rebuilt).toBe(true);
    settings = JSON.parse(
      await readFile(join(rebuilt.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.autoMode).toEqual(localAutoMode);
  });

  test("credentialsSource: rebuild keeps the freshest token (no logged-out-after-relaunch)", async () => {
    // Regression: Anthropic rotates the refresh token on every refresh. The old
    // preserve step blindly resurrected the runtime's own .credentials.json on a
    // rebuild — even when it held a dead, rotated token while the freshly-synced
    // source had the live one — booting the relaunched profile into a logged-out
    // state. The preserve step must keep whichever token has the higher expiresAt.
    const stale = join(root, "src-stale");
    const fresh = join(root, "src-fresh");
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const STALE = 1_000;
    const FRESH = 9_000_000_000_000;
    await writeFile(
      join(stale, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: STALE, refreshToken: "dead" },
      }),
    );
    await writeFile(
      join(fresh, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: FRESH, refreshToken: "live" },
      }),
    );

    const base = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };
    const p1: ResolvedProfile = { ...sampleProfile, name: "rotate" };
    // Extra skill → different hash → forces a REBUILD (exercises the preserve step).
    const p2: ResolvedProfile = {
      ...sampleProfile,
      name: "rotate",
      skills: {
        local: [{ id: "design/ui-ux-pro-max" }, { id: "design/extra" }],
        npx: [],
      },
    };

    // First launch: runtime ends up with the (then-current) STALE source token.
    const first = await materializeRuntime({
      ...base,
      profile: p1,
      credentialsSource: stale,
    });
    expect(first.rebuilt).toBe(true);

    // syncFreshestToSource has since healed source to the live token. Relaunch
    // with a changed profile → rebuild path runs the preserve step.
    const second = await materializeRuntime({
      ...base,
      profile: p2,
      credentialsSource: fresh,
    });
    expect(second.rebuilt).toBe(true);

    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("live");
    // A runtime's copy carries a staggered expiry so siblings do not all rotate
    // in the same second, so this checks the fresh token's window rather than
    // its exact value — still nowhere near the stale token's expiry.
    expect(creds.claudeAiOauth.expiresAt).toBeLessThanOrEqual(FRESH);
    expect(creds.claudeAiOauth.expiresAt).toBeGreaterThanOrEqual(
      FRESH - MAX_STAGGER_MS,
    );
  });

  test("credentialsSource: rebuild keeps the runtime token when source is half-logged-out", async () => {
    // Inverse guard: if SOURCE is stale/half-logged-out (no/low expiresAt) but the
    // runtime is logged in (fresh token), a rebuild must NOT clobber the live
    // runtime token with the dead source one. Preserves the original intent.
    const fresh = join(root, "src-fresh");
    const loggedOut = join(root, "src-loggedout");
    await mkdir(fresh, { recursive: true });
    await mkdir(loggedOut, { recursive: true });
    const FRESH = 9_000_000_000_000;
    await writeFile(
      join(fresh, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: FRESH, refreshToken: "live" },
      }),
    );
    await writeFile(
      join(loggedOut, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: "" } }),
    );

    const base = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };
    const p1: ResolvedProfile = { ...sampleProfile, name: "rotate2" };
    const p2: ResolvedProfile = {
      ...sampleProfile,
      name: "rotate2",
      skills: {
        local: [{ id: "design/ui-ux-pro-max" }, { id: "design/extra" }],
        npx: [],
      },
    };

    const first = await materializeRuntime({
      ...base,
      profile: p1,
      credentialsSource: fresh,
    });
    expect(first.rebuilt).toBe(true);
    const second = await materializeRuntime({
      ...base,
      profile: p2,
      credentialsSource: loggedOut,
    });
    expect(second.rebuilt).toBe(true);

    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("live");
    // Staggered window, as above — the guard is that the dead source token did
    // not win, not the exact millisecond.
    expect(creds.claudeAiOauth.expiresAt).toBeLessThanOrEqual(FRESH);
    expect(creds.claudeAiOauth.expiresAt).toBeGreaterThanOrEqual(
      FRESH - MAX_STAGGER_MS,
    );
  });

  test("credentialsSource: cache hit re-seeds a FILE .claude.json on account switch", async () => {
    // Regression: runtime dirs are keyed by profile, so two authmux accounts
    // share one runtime. Claude's atomic rewrite turns the .claude.json symlink
    // into a local FILE owned by the last-logged-in account; the overlay's
    // "cue override — don't touch" rule then left the OLD account's identity
    // paired with the NEW account's tokens, forcing a re-login every time the
    // accounts alternated on a profile.
    const credSrcA = join(root, "accA");
    const credSrcB = join(root, "accB");
    await mkdir(credSrcA, { recursive: true });
    await mkdir(credSrcB, { recursive: true });
    await writeFile(
      join(credSrcA, ".credentials.json"),
      '{"claudeAiOauth":{"refreshToken":"A"}}',
    );
    await writeFile(
      join(credSrcB, ".credentials.json"),
      '{"claudeAiOauth":{"refreshToken":"B"}}',
    );
    await writeFile(
      join(credSrcA, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );
    await writeFile(
      join(credSrcB, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-B" } }),
    );

    const args = {
      profile: { ...sampleProfile, name: "acct-switch" },
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    const first = await materializeRuntime({
      ...args,
      credentialsSource: credSrcA,
    });
    expect(first.rebuilt).toBe(true);
    // Simulate Claude Code's atomic rewrite: the .claude.json symlink becomes
    // a local regular file carrying account A's identity + session state.
    await rm(join(first.runtimeDir, ".claude.json"), { force: true });
    await writeFile(
      join(first.runtimeDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: "uuid-A" },
        projects: { "/w": {} },
      }),
    );

    // Account B launches the same profile → cache hit → identity must follow.
    const second = await materializeRuntime({
      ...args,
      credentialsSource: credSrcB,
    });
    expect(second.rebuilt).toBe(false);
    const cj = JSON.parse(
      await readFile(join(second.runtimeDir, ".claude.json"), "utf8"),
    );
    expect(cj.oauthAccount.accountUuid).toBe("uuid-B");
    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("B");
  });

  test("credentialsSource: a cue runtime never overlays itself into self-loop symlinks", async () => {
    const account = join(root, "account");
    await mkdir(account, { recursive: true });
    await writeFile(
      join(account, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { refreshToken: "live", expiresAt: 9_000_000_000_000 },
      }),
    );
    await writeFile(
      join(account, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-live" } }),
    );

    const args = {
      profile: {
        ...sampleProfile,
        name: "self-source",
        inheritanceChain: ["self-source"],
      },
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    const first = await materializeRuntime({
      ...args,
      credentialsSource: account,
    });
    await mkdir(join(first.runtimeDir, "cache"), { recursive: true });
    await writeFile(join(first.runtimeDir, "cache", "cached"), "data");
    await writeFile(join(first.runtimeDir, ".cue-hash"), "0".repeat(64));

    const second = await materializeRuntime({
      ...args,
      credentialsSource: first.runtimeDir,
    });

    expect(second.rebuilt).toBe(true);
    await expect(readlink(join(second.runtimeDir, "cache"))).rejects.toThrow();
    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("live");
  });

  test("credentialsSource: cache hit keeps a FILE .claude.json when the account matches", async () => {
    // Same-account relaunch must NOT clobber per-profile session state
    // (projects list etc.) that Claude wrote into the runtime's local file.
    const credSrc = join(root, "accSame");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".credentials.json"),
      '{"claudeAiOauth":{"refreshToken":"A"}}',
    );
    await writeFile(
      join(credSrc, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );

    const args = {
      profile: { ...sampleProfile, name: "acct-same" },
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    const first = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    await rm(join(first.runtimeDir, ".claude.json"), { force: true });
    const localState = JSON.stringify({
      oauthAccount: { accountUuid: "uuid-A" },
      projects: { "/w": { history: [1] } },
    });
    await writeFile(join(first.runtimeDir, ".claude.json"), localState);

    const second = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    expect(second.rebuilt).toBe(false);
    // Identity + per-profile session state preserved (syncMcpsIntoClaudeJson
    // legitimately rewrites the file to merge mcpServers, so compare fields,
    // not bytes).
    const cj = JSON.parse(
      await readFile(join(second.runtimeDir, ".claude.json"), "utf8"),
    );
    expect(cj.oauthAccount.accountUuid).toBe("uuid-A");
    expect(cj.projects).toEqual({ "/w": { history: [1] } });
  });

  test("credentialsSource: cache hit keeps the runtime's fresher token", async () => {
    // Regression: the overlay stamped source over the runtime unconditionally.
    // Anthropic rotates the refresh token on every refresh, so only the highest
    // expiresAt is live — and `cue sync` / `cue install` materialize with an
    // UNHEALED source, so one bulk sync could hand every runtime a dead token
    // and force a re-login.
    const STALE = 1_000;
    const FRESH = 9_999_999;
    const credSrc = join(root, "accStaleSource");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );
    await writeFile(
      join(credSrc, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: STALE, refreshToken: "dead" },
      }),
    );

    const args = {
      profile: { ...sampleProfile, name: "cred-cachehit-freshness" },
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    const first = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    expect(first.rebuilt).toBe(true);
    // The running session refreshed, rotating source's token dead.
    await writeFile(
      join(first.runtimeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: FRESH, refreshToken: "live" },
      }),
    );

    const second = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    expect(second.rebuilt).toBe(false);
    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("live");
    expect(creds.claudeAiOauth.expiresAt).toBe(FRESH);
  });

  test("credentialsSource: cache hit re-seeds tokens on account switch even when the runtime's are newer", async () => {
    // The freshness guard above is scoped to ONE account — across accounts the
    // expiry comparison is meaningless and source must win. Source here uses the
    // real default-account layout (identity at the home root, stub inside
    // `.claude/`), so this also covers that fallback: without it the switch reads
    // as same-account and the runtime's newer token would wrongly survive.
    const home = join(root, "homeB");
    const credSrc = join(home, ".claude");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".claude.json"),
      JSON.stringify({ firstStartTime: "t" }),
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-B" } }),
    );
    await writeFile(
      join(credSrc, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: 1_000, refreshToken: "B" },
      }),
    );

    const args = {
      profile: { ...sampleProfile, name: "cred-cachehit-switch" },
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };

    const first = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    expect(first.rebuilt).toBe(true);
    // Account A had been logged in here: Claude's atomic rewrite left a local
    // FILE identity, and A's token outlives B's.
    await rm(join(first.runtimeDir, ".claude.json"), { force: true });
    await writeFile(
      join(first.runtimeDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );
    await writeFile(
      join(first.runtimeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: 9_999_999, refreshToken: "A" },
      }),
    );

    const second = await materializeRuntime({
      ...args,
      credentialsSource: credSrc,
    });
    expect(second.rebuilt).toBe(false);
    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("B");
  });

  test("credentialsSource: rebuild does not resurrect another account's identity or tokens", async () => {
    // The preserve step's expiresAt comparison is meaningless across accounts:
    // the old runtime's token may expire later yet belong to the OTHER account.
    // On a cross-account rebuild the source state must win wholesale.
    const credSrcA = join(root, "rebA");
    const credSrcB = join(root, "rebB");
    await mkdir(credSrcA, { recursive: true });
    await mkdir(credSrcB, { recursive: true });
    const LATER = 9_000_000_000_000;
    await writeFile(
      join(credSrcA, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: LATER, refreshToken: "A" },
      }),
    );
    await writeFile(
      join(credSrcB, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: 1_000, refreshToken: "B" },
      }),
    );
    await writeFile(
      join(credSrcA, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );
    await writeFile(
      join(credSrcB, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-B" } }),
    );

    const base = {
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem" } },
      userClaudeMd: "",
    };
    const p1: ResolvedProfile = { ...sampleProfile, name: "acct-rebuild" };
    const p2: ResolvedProfile = {
      ...sampleProfile,
      name: "acct-rebuild",
      skills: {
        local: [{ id: "design/ui-ux-pro-max" }, { id: "design/extra" }],
        npx: [],
      },
    };

    const first = await materializeRuntime({
      ...base,
      profile: p1,
      credentialsSource: credSrcA,
    });
    // Claude's rewrite pins account A's identity into the runtime as a FILE.
    await rm(join(first.runtimeDir, ".claude.json"), { force: true });
    await writeFile(
      join(first.runtimeDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-A" } }),
    );

    // Account B relaunches with a changed profile → rebuild + preserve step.
    const second = await materializeRuntime({
      ...base,
      profile: p2,
      credentialsSource: credSrcB,
    });
    expect(second.rebuilt).toBe(true);
    const creds = JSON.parse(
      await readFile(join(second.runtimeDir, ".credentials.json"), "utf8"),
    );
    expect(creds.claudeAiOauth.refreshToken).toBe("B");
    const cj = JSON.parse(
      await readFile(join(second.runtimeDir, ".claude.json"), "utf8"),
    );
    expect(cj.oauthAccount.accountUuid).toBe("uuid-B");
  });

  test("CLAUDE.md stamp uses real ISO timestamp, not literal $(date)", async () => {
    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const claudemd = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    expect(claudemd).not.toContain("$(date)");
    expect(claudemd).toMatch(/generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ---------------------------------------------------------------------------
  // Rules / commands / hooks — ECC-derived resource paths
  // ---------------------------------------------------------------------------

  test("commands: symlinks each ref into commands/ and lists them in CLAUDE.md", async () => {
    // Materializer resolves command refs against <repo>/resources/commands/<ref>.md
    // — we already vendor a few of these, so use a known-good one.
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-cmds",
      inheritanceChain: ["test-cmds"],
      rules: [],
      hooks: [],
      commands: ["code-review", "checkpoint"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const cmdLink = await readlink(
      join(out.runtimeDir, "commands", "code-review.md"),
    );
    expect(cmdLink).toContain("resources/commands/code-review.md");
    const claudemd = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    expect(claudemd).toContain("## Available Commands");
    expect(claudemd).toContain("/code-review");
    expect(claudemd).toContain("/checkpoint");
  });

  test("subagents: symlinks each ref flat into agents/", async () => {
    // Resolved against <repo>/resources/subagents/<ref>.md — use known-good
    // vendored agents from the imported agency-agents set.
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-subagents",
      inheritanceChain: ["test-subagents"],
      rules: [],
      hooks: [],
      commands: [],
      subagents: ["design/design-ui-designer", "testing/testing-api-tester"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    // Division prefix is flattened to the basename in agents/.
    const link = await readlink(
      join(out.runtimeDir, "agents", "design-ui-designer.md"),
    );
    expect(link).toContain("resources/subagents/design/design-ui-designer.md");
    const link2 = await readlink(
      join(out.runtimeDir, "agents", "testing-api-tester.md"),
    );
    expect(link2).toContain(
      "resources/subagents/testing/testing-api-tester.md",
    );
    // Stamp surfaces the roster so the model knows what it can delegate to.
    const claudemd = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    expect(claudemd).toContain("## Subagents (2)");
    expect(claudemd).toContain("design-ui-designer");
    expect(claudemd).toContain("testing-api-tester");
  });

  test("subagents: no agents/ dir when none declared (preserves ~/.claude/agents passthrough)", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-no-subagents",
      inheritanceChain: ["test-no-subagents"],
      rules: [],
      hooks: [],
      commands: [],
      subagents: [],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    let exists = true;
    try {
      await lstat(join(out.runtimeDir, "agents"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("rules: symlinks into rules/ + writes index (NOT inlined bodies)", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-rules",
      inheritanceChain: ["test-rules"],
      commands: [],
      hooks: [],
      rules: ["common/security", "common/testing"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const link = await readlink(join(out.runtimeDir, "rules", "security.md"));
    expect(link).toContain("resources/rules/common/security.md");
    const claudemd = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    // Index reference present, but the rule body must NOT be inlined — the
    // whole point of the symlink-only approach is to skip the token bleed.
    expect(claudemd).toContain("## Rules (2)");
    expect(claudemd).toContain("`rules/security.md`");
    expect(claudemd).not.toMatch(/^## Security Review Triggers/m);
  });

  test("hooks: merges hook JSON into settings.json under matching event keys", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-hooks",
      inheritanceChain: ["test-hooks"],
      rules: [],
      commands: [],
      hooks: ["bash-quality-preflight.json", "session-summary.json"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toBeArray();
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.Stop).toBeArray();
    expect(settings.hooks.Stop[0].hooks[0].id).toBe("cue:stop:session-summary");
    // Symlinks also created under hooks/
    const link = await readlink(
      join(out.runtimeDir, "hooks", "bash-quality-preflight.json"),
    );
    expect(link).toContain("resources/hooks/bash-quality-preflight.json");
  });

  test("hooks: auto-review Stop hook + its .sh companion both land in the runtime", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-auto-review",
      inheritanceChain: ["test-auto-review"],
      rules: [],
      commands: [],
      hooks: ["auto-review.json"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toBeArray();
    expect(settings.hooks.Stop[0].hooks[0].id).toBe("cue:stop:auto-review");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("auto-review.sh");
    // The reviewer script companion must be symlinked too, else the hook fires
    // `bash $CLAUDE_CONFIG_DIR/hooks/auto-review.sh` against a missing file.
    const script = await readlink(
      join(out.runtimeDir, "hooks", "auto-review.sh"),
    );
    expect(script).toContain("resources/hooks/auto-review.sh");
  });

  // Claude Code reads MCP servers from .claude.json (top-level `mcpServers`),
  // NOT from settings.json. The materializer must therefore merge profile MCPs
  // into .claude.json — and copy (not symlink) it so mutations don't leak back
  // into the shared account file.
  test("merges profile MCPs into .claude.json + copies (not symlinks) it", async () => {
    const credSrc = join(root, "creds");
    const { mkdir, writeFile, lstat } = await import("node:fs/promises");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".claude.json"),
      JSON.stringify({
        numStartups: 42,
        oauthAccount: { emailAddress: "u@example.com" },
        mcpServers: { preexisting: { command: "/bin/pre" } },
      }),
    );

    const out = await materializeRuntime({
      profile: sampleProfile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    });

    // Must be a real file, not a symlink — otherwise mutations leak back to
    // the source account file and pollute other profiles sharing the account.
    const st = await lstat(join(out.runtimeDir, ".claude.json"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);

    // Profile MCPs merged in under top-level `mcpServers`, preserving the
    // source's preexisting entries and other top-level fields.
    const cj = JSON.parse(
      await readFile(join(out.runtimeDir, ".claude.json"), "utf8"),
    );
    expect(cj.mcpServers["claude-mem"]).toEqual({
      command: "claude-mem",
      args: [],
    });
    expect(cj.mcpServers["preexisting"]).toEqual({ command: "/bin/pre" });
    expect(cj.numStartups).toBe(42);
    expect(cj.oauthAccount).toEqual({ emailAddress: "u@example.com" });

    // Source .claude.json untouched — proof the copy isolates per-profile writes.
    const src = JSON.parse(
      await readFile(join(credSrc, ".claude.json"), "utf8"),
    );
    expect(src.mcpServers).toEqual({ preexisting: { command: "/bin/pre" } });
  });

  // Cache-hit path must also re-sync MCPs into .claude.json, so adding/removing
  // an MCP to a profile takes effect even when the profile hash hasn't changed
  // for unrelated reasons. (In practice, adding an MCP changes the hash — but
  // an account swap with a different source .claude.json triggers a cache hit.)
  test("cache hit: refreshes .claude.json mcpServers from current registry", async () => {
    const credSrc = join(root, "creds");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(credSrc, { recursive: true });
    await writeFile(
      join(credSrc, ".claude.json"),
      JSON.stringify({ numStartups: 1 }),
    );

    const args = {
      profile: sampleProfile,
      agent: "claude-code" as const,
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id: string) => `/fake/source/${id}`,
      mcpRegistry: { "claude-mem": { command: "claude-mem-v1" } },
      userClaudeMd: "",
      credentialsSource: credSrc,
    };
    await materializeRuntime(args);

    // Second build: same profile (hash hit) but registry changed.
    const second = await materializeRuntime({
      ...args,
      mcpRegistry: { "claude-mem": { command: "claude-mem-v2" } },
    });
    expect(second.rebuilt).toBe(false);

    const cj = JSON.parse(
      await readFile(join(second.runtimeDir, ".claude.json"), "utf8"),
    );
    expect(cj.mcpServers["claude-mem"]).toEqual({ command: "claude-mem-v2" });
  });

  // ---------------------------------------------------------------------------
  // Resolution + size guards
  // ---------------------------------------------------------------------------

  test("fail-loud: aborts (and preserves old runtime) when >half the skills fail to resolve", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-resolve-fail",
      inheritanceChain: ["test-resolve-fail"],
      skills: {
        local: [{ id: "a/one" }, { id: "a/two" }, { id: "a/three" }],
        npx: [],
      },
    };
    const runtimeRoot = join(root, "runtime");

    // First build succeeds (everything resolves) so an old runtime exists.
    const ok = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot,
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "# original\n",
    });
    expect(await readFile(join(ok.runtimeDir, "CLAUDE.md"), "utf8")).toContain(
      "# original",
    );

    // Second build: profile content changed (cache miss) + lookup now fails for
    // 2 of 3 skills → >50% → must throw and leave the old runtime untouched.
    let threw = false;
    try {
      await materializeRuntime({
        profile: { ...profile, plugins: [{ id: "changed@x" }] },
        agent: "claude-code",
        runtimeRoot,
        skillSourceLookup: async (id) => {
          if (id === "a/one") return `/fake/source/${id}`;
          throw new Error("missing");
        },
        mcpRegistry: {},
        userClaudeMd: "# replacement\n",
      });
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("skill resolution failed");
    }
    expect(threw).toBe(true);
    // Old runtime preserved (throw happens before the atomic swap).
    expect(await readFile(join(ok.runtimeDir, "CLAUDE.md"), "utf8")).toContain(
      "# original",
    );
  });

  test("fail-loud: CUE_ALLOW_PARTIAL_SKILLS=1 bypasses the abort", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-resolve-bypass",
      inheritanceChain: ["test-resolve-bypass"],
      skills: { local: [{ id: "a/one" }, { id: "a/two" }], npx: [] },
    };
    const prev = process.env.CUE_ALLOW_PARTIAL_SKILLS;
    process.env.CUE_ALLOW_PARTIAL_SKILLS = "1";
    try {
      const out = await materializeRuntime({
        profile,
        agent: "claude-code",
        runtimeRoot: join(root, "runtime"),
        skillSourceLookup: async () => {
          throw new Error("missing");
        },
        mcpRegistry: {},
        userClaudeMd: "",
      });
      expect(out.rebuilt).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CUE_ALLOW_PARTIAL_SKILLS;
      else process.env.CUE_ALLOW_PARTIAL_SKILLS = prev;
    }
  });

  test("size guard: warns when the generated CLAUDE.md exceeds the perf threshold", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      await materializeRuntime({
        profile: sampleProfile,
        agent: "claude-code",
        runtimeRoot: join(root, "runtime"),
        skillSourceLookup: async (id) => `/fake/source/${id}`,
        mcpRegistry: {},
        userClaudeMd: "x".repeat(41_000),
      });
    } finally {
      (process.stderr as any).write = orig;
    }
    const warning = captured.join("");
    expect(warning).toContain("CLAUDE.md for profile");
    expect(warning).toMatch(/4\d\.\dk chars/);
  });

  test("size guard: silent for a normal-sized CLAUDE.md", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      await materializeRuntime({
        profile: sampleProfile,
        agent: "claude-code",
        runtimeRoot: join(root, "runtime"),
        skillSourceLookup: async (id) => `/fake/source/${id}`,
        mcpRegistry: {},
        userClaudeMd: "# small\n",
      });
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(captured.join("")).not.toContain("perf");
  });

  test("size guard: does not apply Claude's memory-file warning to Codex", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      await materializeRuntime({
        profile: { ...sampleProfile, agents: ["codex"] },
        agent: "codex",
        runtimeRoot: join(root, "runtime"),
        skillSourceLookup: async (id) => `/fake/source/${id}`,
        mcpRegistry: {},
        userClaudeMd: "x".repeat(56_200),
      });
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(captured.join("")).not.toContain("AGENTS.md for profile");
  });

  test("missing rule/command/hook ref is non-fatal", async () => {
    const profile: ResolvedProfile = {
      ...sampleProfile,
      name: "test-missing",
      inheritanceChain: ["test-missing"],
      rules: ["does/not/exist"],
      commands: ["ghost-command"],
      hooks: ["nope.json"],
    };
    const out = await materializeRuntime({
      profile,
      agent: "claude-code",
      runtimeRoot: join(root, "runtime"),
      skillSourceLookup: async (id) => `/fake/source/${id}`,
      mcpRegistry: {},
      userClaudeMd: "",
    });
    expect(out.rebuilt).toBe(true);
    // No symlinks created for missing refs — directories may exist but be empty.
    const settings = JSON.parse(
      await readFile(join(out.runtimeDir, "settings.json"), "utf8"),
    );
    expect(settings.hooks).toBeUndefined();
  });
});

describe("isRuntimeStale", () => {
  let profilesRoot: string;
  let savedEnv: string | undefined;
  beforeEach(async () => {
    profilesRoot = await mkdtemp(join(tmpdir(), "cue-profiles-"));
    savedEnv = process.env.CUE_PROFILES_DIR;
    process.env.CUE_PROFILES_DIR = profilesRoot;
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.CUE_PROFILES_DIR;
    else process.env.CUE_PROFILES_DIR = savedEnv;
    await rm(profilesRoot, { recursive: true, force: true });
  });

  async function setup(name: string, runtimeRoot: string) {
    const yamlPath = join(profilesRoot, name, "profile.yaml");
    await mkdir(join(profilesRoot, name), { recursive: true });
    await writeFile(yamlPath, "name: x\n");
    const hashDir = join(runtimeRoot, name, "claude");
    await mkdir(hashDir, { recursive: true });
    const hashPath = join(hashDir, ".cue-hash");
    await writeFile(hashPath, "deadbeef");
    return { yamlPath, hashPath };
  }

  test("returns true when profile.yaml is newer than .cue-hash", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p1", runtimeRoot);
    // Hash built in the past, profile.yaml edited just now.
    await utimes(
      hashPath,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await utimes(yamlPath, new Date(), new Date());
    expect(await isRuntimeStale("p1", "claude-code", runtimeRoot)).toBe(true);
  });

  test("returns false when .cue-hash is newer than profile.yaml", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p2", runtimeRoot);
    await utimes(
      yamlPath,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await utimes(hashPath, new Date(), new Date());
    expect(await isRuntimeStale("p2", "claude-code", runtimeRoot)).toBe(false);
  });

  test("returns false when there is no runtime hash yet", async () => {
    const runtimeRoot = join(root, "runtime");
    await mkdir(join(profilesRoot, "p3"), { recursive: true });
    await writeFile(join(profilesRoot, "p3", "profile.yaml"), "name: x\n");
    expect(await isRuntimeStale("p3", "claude-code", runtimeRoot)).toBe(false);
  });

  async function writeRuntimeSkill(
    name: string,
    runtimeRoot: string,
    slug: string,
  ): Promise<string> {
    const skillDir = join(runtimeRoot, name, "claude", "skills", slug);
    await mkdir(skillDir, { recursive: true });
    const md = join(skillDir, "SKILL.md");
    await writeFile(md, `# ${slug}\n`);
    return md;
  }

  test("returns true when a resolved SKILL.md is newer than .cue-hash (yaml older)", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p4", runtimeRoot);
    const mdPath = await writeRuntimeSkill("p4", runtimeRoot, "alpha");
    await utimes(
      yamlPath,
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 120_000),
    );
    await utimes(
      hashPath,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await utimes(mdPath, new Date(), new Date());
    expect(await isRuntimeStale("p4", "claude-code", runtimeRoot)).toBe(true);
  });

  test("returns false when every SKILL.md is older than .cue-hash", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p5", runtimeRoot);
    const mdPath = await writeRuntimeSkill("p5", runtimeRoot, "alpha");
    const old = new Date(Date.now() - 60_000);
    await utimes(yamlPath, old, old);
    await utimes(mdPath, old, old);
    await utimes(hashPath, new Date(), new Date());
    expect(await isRuntimeStale("p5", "claude-code", runtimeRoot)).toBe(false);
  });

  test("skips a slug dir with no SKILL.md (broken symlink is non-fatal)", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p6", runtimeRoot);
    await mkdir(join(runtimeRoot, "p6", "claude", "skills", "broken"), {
      recursive: true,
    });
    await utimes(
      yamlPath,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await utimes(hashPath, new Date(), new Date());
    expect(await isRuntimeStale("p6", "claude-code", runtimeRoot)).toBe(false);
  });

  test("detects a newer SKILL.md through a symlinked skill dir (production layout)", async () => {
    const runtimeRoot = join(root, "runtime");
    const { yamlPath, hashPath } = await setup("p7", runtimeRoot);
    // Production materialize symlinks skills/<slug> → the source skill dir; the
    // SKILL.md inside is a real file, so lstat resolves through to its mtime.
    const src = join(profilesRoot, "src-skill-p7");
    await mkdir(src, { recursive: true });
    const srcMd = join(src, "SKILL.md");
    await writeFile(srcMd, "# s\n");
    const skillsDir = join(runtimeRoot, "p7", "claude", "skills");
    await mkdir(skillsDir, { recursive: true });
    await symlink(src, join(skillsDir, "s"));
    await utimes(
      yamlPath,
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 120_000),
    );
    await utimes(
      hashPath,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await utimes(srcMd, new Date(), new Date());
    expect(await isRuntimeStale("p7", "claude-code", runtimeRoot)).toBe(true);
  });
});

describe("linkPluginCache", () => {
  let src: string;
  let tgt: string;
  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), "cue-plugsrc-"));
    tgt = await mkdtemp(join(tmpdir(), "cue-plugtgt-"));
  });
  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(tgt, { recursive: true, force: true });
  });

  test("symlinks cache + marketplace metadata to the real source, leaving registry/data alone", async () => {
    // Real source: a fully-downloaded plugin tree.
    const verDir = join(
      src,
      "plugins",
      "cache",
      "thedotmack",
      "claude-mem",
      "13.3.0",
    );
    await mkdir(verDir, { recursive: true });
    await writeFile(join(verDir, "hooks.json"), "{}");
    await mkdir(join(src, "plugins", "marketplaces"), { recursive: true });
    await writeFile(join(src, "plugins", "known_marketplaces.json"), "{}");

    // Target runtime: Claude's lazy empty stubs that must be replaced.
    await mkdir(join(tgt, "plugins", "cache"), { recursive: true }); // empty real dir
    await writeFile(
      join(tgt, "plugins", "installed_plugins.json"),
      '{"version":2,"plugins":{}}',
    );
    await mkdir(join(tgt, "plugins", "data"), { recursive: true });

    await linkPluginCache(tgt, src);

    // cache is now a symlink to the real tree → the version dir resolves.
    const cacheLink = join(tgt, "plugins", "cache");
    expect((await lstat(cacheLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(cacheLink)).toBe(join(src, "plugins", "cache"));
    expect(
      (
        await stat(
          join(cacheLink, "thedotmack", "claude-mem", "13.3.0", "hooks.json"),
        )
      ).isFile(),
    ).toBe(true);

    // marketplace metadata linked too.
    expect(
      (await lstat(join(tgt, "plugins", "marketplaces"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      (
        await lstat(join(tgt, "plugins", "known_marketplaces.json"))
      ).isSymbolicLink(),
    ).toBe(true);

    // installed_plugins.json is NOT a symlink (Claude owns it; never clobber the real one).
    expect(
      (
        await lstat(join(tgt, "plugins", "installed_plugins.json"))
      ).isSymbolicLink(),
    ).toBe(false);
    // data stays a real local dir (ELOOP-safe).
    expect((await lstat(join(tgt, "plugins", "data"))).isSymbolicLink()).toBe(
      false,
    );
  });

  test("is a no-op when the source has no plugins tree", async () => {
    await linkPluginCache(tgt, src); // src has no plugins/
    // No plugins dir created, nothing thrown.
    await expect(lstat(join(tgt, "plugins", "cache"))).rejects.toThrow();
  });

  test("is a no-op when asked to link a runtime's plugin cache to itself", async () => {
    await mkdir(join(src, "plugins", "cache"), { recursive: true });
    await writeFile(join(src, "plugins", "cache", "payload"), "x");

    await linkPluginCache(src, src);

    const cache = await lstat(join(src, "plugins", "cache"));
    expect(cache.isDirectory()).toBe(true);
    expect(
      await readFile(join(src, "plugins", "cache", "payload"), "utf8"),
    ).toBe("x");
  });
});

describe("shouldIncludeSessionTelemetry", () => {
  test("default (unset) → false: telemetry sections are trimmed", () => {
    expect(shouldIncludeSessionTelemetry({})).toBe(false);
  });

  test("CUE_SESSION_TELEMETRY=1 or 'true' → opt back in", () => {
    expect(shouldIncludeSessionTelemetry({ CUE_SESSION_TELEMETRY: "1" })).toBe(
      true,
    );
    expect(
      shouldIncludeSessionTelemetry({ CUE_SESSION_TELEMETRY: "true" }),
    ).toBe(true);
  });

  test("any other value → stays trimmed", () => {
    expect(shouldIncludeSessionTelemetry({ CUE_SESSION_TELEMETRY: "0" })).toBe(
      false,
    );
    expect(
      shouldIncludeSessionTelemetry({ CUE_SESSION_TELEMETRY: "yes" }),
    ).toBe(false);
  });
});

// End-to-end: prove the telemetry sections are absent by default and present
// when opted in, materializing a real profile name (so analytics/last-session
// lookups have data to surface) into a throwaway runtimeRoot.
describe("materializeRuntime — session-telemetry gating", () => {
  const realName = "core+gstack+skill-writer";
  const probe: ResolvedProfile = {
    name: realName,
    description: "telemetry gate probe",
    icon: "🧪",
    skills: { local: [{ id: "caveman/caveman" }], npx: [] },
    mcps: [],
    plugins: [],
    env: {},
    inheritanceChain: [realName],
  } as unknown as ResolvedProfile;
  const base = {
    profile: probe,
    agent: "claude-code" as const,
    skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
    mcpRegistry: {},
    userClaudeMd: "# user CLAUDE.md\n",
  };
  const SAVED = process.env.CUE_SESSION_TELEMETRY;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.CUE_SESSION_TELEMETRY;
    else process.env.CUE_SESSION_TELEMETRY = SAVED;
  });

  test("default omits the three telemetry section headers", async () => {
    delete process.env.CUE_SESSION_TELEMETRY;
    const out = await materializeRuntime({
      ...base,
      runtimeRoot: join(root, "off"),
    });
    const md = await readFile(join(out.runtimeDir, "CLAUDE.md"), "utf8");
    expect(md).not.toContain("## Skill Usage (last 30 days)");
    expect(md).not.toContain("## Last Session");
    expect(md).not.toContain("## Common Workflows");
  });

  test("opted-in materialization is >= default size (sections only add bytes)", async () => {
    delete process.env.CUE_SESSION_TELEMETRY;
    const off = await materializeRuntime({
      ...base,
      runtimeRoot: join(root, "a"),
    });
    const offBytes = (await readFile(join(off.runtimeDir, "CLAUDE.md"), "utf8"))
      .length;
    process.env.CUE_SESSION_TELEMETRY = "1";
    const on = await materializeRuntime({
      ...base,
      runtimeRoot: join(root, "b"),
    });
    const onBytes = (await readFile(join(on.runtimeDir, "CLAUDE.md"), "utf8"))
      .length;
    expect(onBytes).toBeGreaterThanOrEqual(offBytes);
  });
});

describe("session telemetry helpers", () => {
  test("summarizes the newest matching Claude session", async () => {
    const projectsDir = join(root, "projects");
    const cwdKey = process.cwd().replace(/\//g, "-").slice(1, 30);
    const projectDir = join(projectsDir, `${cwdKey}-fixture`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "2026-08-24.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { content: "Implemented the portable profile handoff successfully. Extra detail." },
      })}\n`,
    );

    const summary = await getLastSessionSummary("core", projectsDir);
    expect(summary).toContain("Last session");
    expect(summary).toContain("Implemented the portable profile handoff successfully");
  });

  test("builds workflow hints from profile skill usage", async () => {
    const projectsDir = join(root, "projects");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      join(projectsDir, "usage.log"),
      [
        "skills/alpha/SKILL.md",
        "skills/alpha/SKILL.md",
        "skills/beta/SKILL.md",
        "skills/gamma/SKILL.md",
      ].join("\n"),
    );

    const hint = await getSkillChains(
      ["test/alpha", "test/beta", "test/gamma"],
      projectsDir,
    );
    expect(hint).toContain("alpha → beta → gamma");
  });
});

/**
 * The rebuild swap used to be `rm -rf runtimeDir` followed by `rename(tmp)`,
 * which left CLAUDE_CONFIG_DIR nonexistent for the entire recursive delete.
 * A Claude Code session already running against the profile resolves its hooks
 * through that path, so every hook firing in the gap died with "No such file or
 * directory" (2026-08-03: nine Stop hooks at once).
 *
 * The swap now moves the old tree to a `.old-<pid>-<ts>` sibling first. These
 * tests pin the observable half of that — the sibling is transient, and a
 * leftover from a swap killed between the two renames gets swept. They do NOT
 * pin the ordering itself; a revert to rm-then-rename would still pass, so keep
 * the comment above the swap in runtime-materializer.ts.
 */
describe("materializeRuntime — rebuild swap leftovers", () => {
  const swapArgs = (runtimeRoot: string) => ({
    profile: sampleProfile,
    agent: "claude-code" as const,
    runtimeRoot,
    skillSourceLookup: async (id: string) => `/fake/skills/${id}`,
    mcpRegistry: { "claude-mem": { command: "claude-mem", args: [] } },
    userClaudeMd: "# user CLAUDE.md\n",
  });

  const swapSiblings = async (runtimeDir: string) => {
    const { readdir } = await import("node:fs/promises");
    const { dirname, basename } = await import("node:path");
    const names = await readdir(dirname(runtimeDir));
    return names.filter((n) => n.startsWith(`${basename(runtimeDir)}.old-`));
  };

  test("a rebuild leaves no .old-* sibling behind", async () => {
    const runtimeRoot = join(root, "runtime");
    const first = await materializeRuntime(swapArgs(runtimeRoot));
    // Force a real rebuild rather than the hash-unchanged fast path.
    await writeFile(join(first.runtimeDir, ".cue-hash"), "0".repeat(64));
    const second = await materializeRuntime(swapArgs(runtimeRoot));

    expect(second.rebuilt).toBe(true);
    expect(await swapSiblings(second.runtimeDir)).toEqual([]);
    // The runtime is intact, not a half-swapped shell.
    expect(
      JSON.parse(
        await readFile(join(second.runtimeDir, "settings.json"), "utf8"),
      ),
    ).toBeTruthy();
  });

  test("sweeps a .old-* left by a swap that died between the two renames", async () => {
    const runtimeRoot = join(root, "runtime");
    const first = await materializeRuntime(swapArgs(runtimeRoot));

    const stale = `${first.runtimeDir}.old-99999-deadbeef`;
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "junk"), "x");
    await writeFile(join(first.runtimeDir, ".cue-hash"), "0".repeat(64));

    const second = await materializeRuntime(swapArgs(runtimeRoot));

    expect(await swapSiblings(second.runtimeDir)).toEqual([]);
  });

  test("serializes concurrent rebuilds and preserves Codex session state", async () => {
    const runtimeRoot = join(root, "runtime-concurrent");
    const args = { ...swapArgs(runtimeRoot), agent: "codex" as const };
    const first = await materializeRuntime(args);
    await mkdir(join(first.runtimeDir, "sessions"), { recursive: true });
    await writeFile(
      join(first.runtimeDir, "sessions", "active.jsonl"),
      "thread-state\n",
    );
    await writeFile(join(first.runtimeDir, ".cue-hash"), "0".repeat(64));

    const [a, b] = await Promise.all([
      materializeRuntime(args),
      materializeRuntime(args),
    ]);

    expect([a.rebuilt, b.rebuilt].sort()).toEqual([false, true]);
    expect(
      await readFile(
        join(first.runtimeDir, "sessions", "active.jsonl"),
        "utf8",
      ),
    ).toBe("thread-state\n");
  });

  test("recovers an abandoned materialization lock", async () => {
    const runtimeRoot = join(root, "runtime-abandoned-lock");
    const runtimeDir = join(runtimeRoot, sampleProfile.name, "claude");
    const lockDir = `${runtimeDir}.lock`;
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 700_000);
    await utimes(lockDir, old, old);

    const out = await materializeRuntime(swapArgs(runtimeRoot));

    expect(out.rebuilt).toBe(true);
    expect(await lstat(out.runtimeDir)).toBeTruthy();
    await expect(lstat(lockDir)).rejects.toThrow();
  });

  test("releases the lock after a failed build so a retry can succeed", async () => {
    const runtimeRoot = join(root, "runtime-failed-build");
    const args = swapArgs(runtimeRoot);
    await expect(
      materializeRuntime({
        ...args,
        skillSourceLookup: async () => {
          throw new Error("missing skill");
        },
      }),
    ).rejects.toThrow();

    const out = await materializeRuntime(args);

    expect(out.rebuilt).toBe(true);
    expect(
      await readFile(join(out.runtimeDir, ".cue-hash"), "utf8"),
    ).not.toBeEmpty();
  });
});
