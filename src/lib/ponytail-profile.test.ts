import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./profile-loader";
import { withCodexPonytail } from "./codex-ponytail";

let priorProfilesDir: string | undefined;
beforeEach(() => {
  priorProfilesDir = process.env.CUE_PROFILES_DIR;
  process.env.CUE_PROFILES_DIR = fileURLToPath(new URL("../../profiles", import.meta.url));
});
afterEach(() => {
  if (priorProfilesDir === undefined) delete process.env.CUE_PROFILES_DIR;
  else process.env.CUE_PROFILES_DIR = priorProfilesDir;
});

test("Ponytail adds six pinned skills without changing core plugins or hooks", async () => {
  const core = await loadProfile("core");
  const profile = await loadProfile("ponytail");
  const upstream = profile.skills.npx.find((source) => source.repo === "DietrichGebert/ponytail");

  expect(profile.kind).toBe("overlay");
  expect(profile.agents).toEqual(["claude-code", "codex"]);
  expect(upstream?.pin).toMatch(/^git@[a-f0-9]{40}$/);
  expect(upstream?.skills).toEqual([
    "ponytail", "ponytail-review", "ponytail-audit",
    "ponytail-debt", "ponytail-gain", "ponytail-help",
  ]);
  expect(profile.plugins).toEqual(core.plugins);
  expect(profile.codex).toEqual(core.codex);
  expect(profile.hooks).toEqual(core.hooks);
  expect(profile.mcps).toEqual(core.mcps);
  expect(core.skills.npx.some((source) => source.repo === "DietrichGebert/ponytail")).toBe(false);
});

for (const baseName of ["frontend", "nextjs"]) {
  test(`Ponytail composes with ${baseName} without replacing its skills`, async () => {
    const base = await loadProfile(baseName);
    const combined = await loadProfile(`${baseName}+ponytail`);

    for (const skill of base.skills.local) {
      expect(combined.skills.local).toContainEqual(skill);
    }
    for (const source of base.skills.npx) {
      expect(combined.skills.npx).toContainEqual(source);
    }
    expect(combined.skills.npx.filter((source) => source.repo === "DietrichGebert/ponytail")).toHaveLength(1);
  });
}

for (const name of ["core", "backend", "frontend", "nextjs+browser"]) {
  test(`Codex defaults add Ponytail to ${name} without changing its identity or settings`, async () => {
    const base = await loadProfile(name);
    base.persona = "Workspace-specific guidance";
    base.codex = { model_reasoning_effort: "low", sandbox_mode: "read-only" };
    const before = structuredClone(base);
    const result = await withCodexPonytail(base, "codex");
    const ponytail = await loadProfile("ponytail");
    const source = result.skills.npx.find((entry) => entry.repo === "DietrichGebert/ponytail");

    expect(source?.skills).toHaveLength(6);
    expect(source?.pin).toMatch(/^git@[a-f0-9]{40}$/);
    expect(result.persona).toContain(base.persona);
    expect(result.persona).toContain(ponytail.persona.trim());
    expect({ ...result, persona: base.persona, skills: base.skills }).toEqual(base);
    expect(result.skills.local).toEqual(base.skills.local);
    expect(base).toEqual(before);
    expect(await withCodexPonytail(result, "codex")).toEqual(result);
  });
}

test("Claude remains opt-in and an explicit Ponytail profile is not duplicated", async () => {
  const base = await loadProfile("core");
  expect(await withCodexPonytail(base, "claude-code")).toBe(base);
  const selected = await loadProfile("frontend+ponytail");
  expect(await withCodexPonytail(selected, "codex")).toEqual(selected);
});

test("Codex defaults preserve an explicit source pin and complete its skills", async () => {
  const base = await loadProfile("core");
  const pin = `git@${"a".repeat(40)}`;
  base.skills.npx.push({ repo: "DietrichGebert/ponytail", pin, skills: ["ponytail"] });
  const result = await withCodexPonytail(base, "codex");
  const sources = result.skills.npx.filter((entry) => entry.repo === "DietrichGebert/ponytail");
  expect(sources).toHaveLength(1);
  expect(sources[0]?.pin).toBe(pin);
  expect(sources[0]?.skills).toHaveLength(6);
  expect(base.skills.npx.at(-1)?.skills).toEqual(["ponytail"]);
});

test("a Claude-only source cannot suppress the Codex default", async () => {
  const base = await loadProfile("core");
  base.skills.npx.push({
    repo: "DietrichGebert/ponytail", agents: ["claude-code"], skills: ["ponytail"],
  });
  const result = await withCodexPonytail(base, "codex");
  const codexSources = result.skills.npx.filter((entry) =>
    entry.repo === "DietrichGebert/ponytail" && (!entry.agents || entry.agents.includes("codex")),
  );
  expect(codexSources).toHaveLength(1);
  expect(codexSources[0]?.skills).toHaveLength(6);
});
