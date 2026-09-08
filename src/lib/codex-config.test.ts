import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexConfigToml,
  canonicalCodexAuthPath,
  canonicalCodexConfigPath,
  canonicalCodexHome,
  discoverCodexSkillFiles,
  parseBaseCodexConfig,
  extractRuntimeCodexState,
} from "./codex-config";

test("runtime-local approval tables are retained verbatim without stale generated settings", () => {
  const state = `[projects."/home/u/project.with[brackets]"]\ntrust_level = "trusted"\n\n[hooks.state."exact-hash"]\nenabled = true\n\n[hooks.state."disabled-hash"]\nenabled = false`;
  const runtime = `model = "old"\n[features]\nhooks = true\n\n${state}\n\n[mcp_servers.old]\ncommand = "old"\n`;
  expect(extractRuntimeCodexState(runtime)).toBe(state + "\n");
  const generated = buildCodexConfigToml({ overrides: { model: "new" }, mcpServers: {} });
  const parsed = Bun.TOML.parse(generated + "\n" + extractRuntimeCodexState(runtime));
  expect(parsed.model).toBe("new");
  expect(parsed.hooks).toEqual({ state: { "exact-hash": { enabled: true }, "disabled-hash": { enabled: false } } });
  expect(parsed.mcp_servers).toBeUndefined();
  expect(extractRuntimeCodexState("[hooks.SessionStart]\ncommand = 'no'\n")).toBe("");
});

test("table-looking text inside multiline values must never become an approval", () => {
  const text = `instructions = """\n[projects."/not-trusted"]\ntrust_level = "trusted"\n"""\n[projects."/real"]\ntrust_level = "untrusted"\n\n[other]\ntext = '''\n[hooks.state."not-approved"]\nenabled = true\n'''\n`;
  expect(extractRuntimeCodexState(text)).toBe('[projects."/real"]\ntrust_level = "untrusted"\n');
});

const BASE = `# user config
approval_policy = "never"
model = "gpt-5.5"
model_context_window = 400000
model_reasoning_effort = "xhigh"
sandbox_mode = "danger-full-access"

[features]
goals = true
memories = true
js_repl = false

[mcp_servers.colony]
command = "colony"
args = [ "mcp" ]

[mcp_servers.colony.env]
COLONY_HOME = "/somewhere"

[projects."/home/u/x"]
trust_level = "trusted"

[[skills.config]]
name = "unused-global-skill"
enabled = false
`;

describe("canonicalCodexHome", () => {
  test("honors a user-provided CODEX_HOME", () => {
    expect(canonicalCodexHome({
      env: { CODEX_HOME: "/accounts/codex" },
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/accounts/codex");
    expect(canonicalCodexConfigPath({
      env: { CODEX_HOME: "/accounts/codex" },
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/accounts/codex/config.toml");
    expect(canonicalCodexAuthPath({
      env: { CODEX_HOME: "/accounts/codex" },
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/accounts/codex/auth.json");
  });

  test("falls back to ~/.codex when CODEX_HOME is unset", () => {
    expect(canonicalCodexHome({
      env: {},
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/home/user/.codex");
  });

  test("does not reuse a cue runtime as the canonical Codex home", () => {
    expect(canonicalCodexHome({
      env: { CODEX_HOME: "/home/user/.config/cue/runtime/backend/codex" },
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/home/user/.codex");
  });

  test("recovers the persistent Codex home during a nested cue launch", () => {
    expect(canonicalCodexHome({
      env: {
        CODEX_HOME: "/home/user/.config/cue/runtime/backend/codex",
        CUE_CANONICAL_CODEX_HOME: "/accounts/codex",
      },
      homeDir: "/home/user",
      runtimeRoot: "/home/user/.config/cue/runtime",
    })).toBe("/accounts/codex");
  });

  test("detects cue runtimes case-insensitively on Windows", () => {
    expect(canonicalCodexHome({
      env: { CODEX_HOME: "C:\\Users\\User\\.config\\CUE\\runtime\\backend\\codex" },
      homeDir: "C:\\Users\\User",
      runtimeRoot: "c:\\users\\user\\.config\\cue\\runtime",
      platform: "win32",
    })).toBe("C:\\Users\\User\\.codex");
  });
});

describe("parseBaseCodexConfig", () => {
  test("keeps top-level scalars, [features], and skill overrides", () => {
    const base = parseBaseCodexConfig(BASE);
    expect(base.top.model).toBe('"gpt-5.5"');
    expect(base.top.model_reasoning_effort).toBe('"xhigh"');
    expect(base.top.model_context_window).toBe("400000");
    expect(base.features).toEqual({ goals: "true", memories: "true", js_repl: "false" });
    // tables cue owns or that are machine-local never leak in
    expect(base.top.command).toBeUndefined();
    expect(base.top.trust_level).toBeUndefined();
    expect(base.top.COLONY_HOME).toBeUndefined();
    expect(base.skillsConfig).toEqual([
      '[[skills.config]]\nname = "unused-global-skill"\nenabled = false',
    ]);
  });

  test("pulls multi-line arrays and inline tables in whole", () => {
    const base = parseBaseCodexConfig(`
allowed = [
  "a",
  "b",
]
shell = { inherit = "all" }
model = "x"
[features]
`);
    expect(base.top.allowed).toBe('[\n  "a",\n  "b",\n]');
    expect(base.top.shell).toBe('{ inherit = "all" }');
    expect(base.top.model).toBe('"x"');
  });

  test("a bracket inside a string does not start a table", () => {
    const base = parseBaseCodexConfig(`notify = "say [done]"\nmodel = "x"\n`);
    expect(base.top.notify).toBe('"say [done]"');
    expect(base.top.model).toBe('"x"');
  });
});

describe("buildCodexConfigToml", () => {
  test("inherits the base autonomy knobs alongside cue's MCP servers", () => {
    const toml = buildCodexConfigToml({
      baseText: BASE,
      mcpServers: { codegraph: { command: "codegraph", args: ["serve"] } },
    });
    expect(toml).toContain('model_reasoning_effort = "xhigh"');
    expect(toml).toContain("model_context_window = 400000");
    expect(toml).toContain("[features]");
    expect(toml).toContain("goals = true");
    expect(toml).toContain("[mcp_servers.codegraph]");
    // cue owns MCP wiring — the base config's servers must not come along
    expect(toml).not.toContain("[mcp_servers.colony]");
  });

  test("top-level keys precede every table header", () => {
    const toml = buildCodexConfigToml({
      baseText: BASE,
      mcpServers: { codegraph: { command: "codegraph" } },
    });
    const firstTable = toml.indexOf("[");
    expect(toml.indexOf("model_reasoning_effort")).toBeLessThan(firstTable);
  });

  test("the profile block wins over the base, key by key", () => {
    const toml = buildCodexConfigToml({
      baseText: BASE,
      overrides: {
        sandbox_mode: "workspace-write",
        model_reasoning_effort: "high",
        features: { memories: false },
      },
      mcpServers: {},
    });
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).not.toContain("danger-full-access");
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain("memories = false");
    // untouched base keys survive the override
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain("goals = true");
  });

  test("a profile key absent from the base is added", () => {
    const toml = buildCodexConfigToml({
      baseText: "model = \"x\"\n",
      overrides: { model_auto_compact_token_limit: 320000 },
      mcpServers: {},
    });
    expect(toml).toContain("model_auto_compact_token_limit = 320000");
  });

  test("renders native Codex lifecycle hooks from a profile override", () => {
    const toml = buildCodexConfigToml({
      overrides: {
        hooks: {
          SessionStart: [{
            hooks: [{ type: "command", command: "cue handoff hook", timeout: 5 }],
          }],
          Stop: [{
            hooks: [{ type: "command", command: "cue handoff hook", timeout: 5 }],
          }],
        },
      },
      mcpServers: {},
    });

    expect(toml).toContain('hooks = { "SessionStart" = [{ "hooks" = [{ "type" = "command", "command" = "cue handoff hook", "timeout" = 5 }] }], "Stop" = [{ "hooks" = [{ "type" = "command", "command" = "cue handoff hook", "timeout" = 5 }] }] }');
  });

  test("without a base it renders exactly the pre-inheritance MCP-only shape", () => {
    const toml = buildCodexConfigToml({
      mcpServers: {
        "google-ads-mcp": {
          command: "pipx",
          args: ["run", "google-ads-mcp"],
          env: { GOOGLE_PROJECT_ID: "my-project" },
        },
      },
    });
    expect(toml).toBe(
      '[mcp_servers.google-ads-mcp]\n' +
      'command = "pipx"\n' +
      'args = ["run", "google-ads-mcp"]\n' +
      'env = { "GOOGLE_PROJECT_ID" = "my-project" }\n',
    );
  });

  test("scopes Codex to cue-managed skills while preserving base overrides", () => {
    const toml = buildCodexConfigToml({
      baseText: BASE,
      mcpServers: {},
      disabledSkillPaths: ["/repo/.agents/skills/unused/SKILL.md"],
      enabledSkillPaths: ["/runtime/skills/analyze/SKILL.md"],
    });

    const inherited = toml.indexOf('name = "unused-global-skill"');
    const disabled = toml.indexOf('path = "/repo/.agents/skills/unused/SKILL.md"');
    const enabled = toml.indexOf('path = "/runtime/skills/analyze/SKILL.md"');
    expect(inherited).toBeGreaterThan(-1);
    expect(disabled).toBeGreaterThan(inherited);
    expect(enabled).toBeGreaterThan(disabled);
    expect(toml.slice(disabled, enabled)).toContain("enabled = false");
    expect(toml.slice(enabled)).toContain("enabled = true");
  });
});

describe("discoverCodexSkillFiles", () => {
  test("finds user and repository skill files from cwd through the pin directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cue-codex-skills-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const cwd = join(repo, "packages", "api");
    const paths = [
      join(home, ".agents", "skills", "global", "SKILL.md"),
      join(repo, ".agents", "skills", "root", "SKILL.md"),
      join(repo, ".agents", "skills", "bundle", "skills", "nested", "SKILL.md"),
      join(cwd, ".agents", "skills", "local", "SKILL.md"),
    ];
    try {
      for (const path of paths) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "---\nname: test\ndescription: test\n---\n");
      }
      const outside = join(root, ".agents", "skills", "outside", "SKILL.md");
      mkdirSync(join(outside, ".."), { recursive: true });
      writeFileSync(outside, "---\nname: outside\ndescription: outside\n---\n");

      expect(discoverCodexSkillFiles({ cwd, pinDir: repo, homeDir: home })).toEqual(
        [...paths].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
