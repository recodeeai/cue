import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./profile-loader";

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
