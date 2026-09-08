import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanLocalInventory } from "./local-inventory";

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cue-inventory-"));
  dirs.push(root);
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  return { root, put };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("discovers skills once by real path, retaining sources and profile relationships", async () => {
  const { root, put } = fixture();
  put("skills/tools/demo/SKILL.md", "---\nname: Demo\ndescription: Real local skill\n---\nbody");
  mkdirSync(join(root, "agent"));
  symlinkSync(join(root, "skills/tools/demo"), join(root, "agent/demo"));
  symlinkSync(root, join(root, "skills/loop"));
  const data = await scanLocalInventory({
    skillRoots: [join(root, "skills"), join(root, "agent")], mcpFiles: [],
    profiles: [{ name: "backend", description: "Backend", skills: [{ ref: "tools/demo", path: join(root, "skills/tools/demo/SKILL.md") }, { ref: "not-installed" }], mcps: ["remote"] }],
  });
  expect(data.items.filter(x => x.kind === "skill" && x.state === "installed")).toHaveLength(1);
  const skill = data.items.find(x => x.name === "Demo")!;
  expect(skill.sources).toHaveLength(2);
  expect(skill.related).toContain("profile:backend");
  expect(data.items.find(x => x.name === "not-installed")?.state).toBe("referenced");
  expect(data.items.find(x => x.name === "remote")?.state).toBe("referenced");
});

test("MCP inventory never returns config values, commands, URLs, env or parse errors", async () => {
  const { root, put } = fixture();
  put("mcp.json", JSON.stringify({ mcpServers: { local: { command: "SECRET", args: ["SECRET"], env: { TOKEN: "SECRET" }, url: "https://SECRET" } } }));
  put("bad.json", '{"token":"SECRET"');
  put("config.toml", '[mcp_servers."quoted.name"]\ncommand="SECRET"\n[features]\ntext="""\n[mcp_servers.fake]\n"""\n');
  const data = await scanLocalInventory({ skillRoots: [join(root, "missing")], profiles: [], mcpFiles: [join(root, "mcp.json"), join(root, "bad.json"), join(root, "config.toml")] });
  expect(JSON.stringify(data)).not.toContain("SECRET");
  expect(data.items.map(x => x.name).sort()).toEqual(["local", "quoted.name"]);
  expect(data.sources.find(x => x.path.endsWith("bad.json"))?.state).toBe("unreadable");
  expect(data.sources.find(x => x.path.endsWith("missing"))?.state).toBe("missing");
});

test("same MCP name in different configs remains separate, not reported running", async () => {
  const { root, put } = fixture();
  put("a.json", '{"mcpServers":{"same":{"command":"a"}}}');
  put("b.json", '{"mcpServers":{"same":{"command":"b"}}}');
  const data = await scanLocalInventory({ skillRoots: [], profiles: [], mcpFiles: [join(root, "a.json"), join(root, "b.json")] });
  expect(data.items).toHaveLength(2);
  expect(new Set(data.items.map(x => x.id)).size).toBe(2);
  expect(data.items.every(x => x.state === "configured")).toBe(true);
});

test("catalog entries are not installations and plugin MCP JSON is discovered", async () => {
  const { root, put } = fixture();
  put("catalog.json", '{"servers":{"catalog":{"command":"unused"}}}');
  put("plugins/demo/.mcp.json", '{"mcpServers":{"plugin-server":{"command":"unused"}}}');
  put("plugins/direct/.mcp.json", '{"direct-server":{"command":"unused"}}');
  const data = await scanLocalInventory({ skillRoots: [join(root, "plugins")], profiles: [], mcpFiles: [join(root, "catalog.json")], catalogFiles: [join(root, "catalog.json")] });
  expect(data.items.find(x => x.name === "catalog")?.state).toBe("available");
  expect(data.items.find(x => x.name === "plugin-server")?.state).toBe("configured");
  expect(data.items.find(x => x.name === "direct-server")?.state).toBe("configured");
});

test("inventory HTTP route rejects writes, foreign sites, and arbitrary path input", async () => {
  const { createHandler } = await import("./dashboard-server");
  const handler = createHandler();
  for (const [request, expected] of [
    [new Request("http://localhost/api/v1/inventory", { method: "POST" }), 405],
    [new Request("http://localhost/api/v1/inventory", { headers: { "sec-fetch-site": "cross-site" } }), 403],
    [new Request("http://localhost/api/v1/inventory?path=/etc"), 400],
  ] as const) {
    const response = await handler(request);
    expect(response.status).toBe(expected);
    expect((await response.json()).ok).toBe(false);
  }
});
