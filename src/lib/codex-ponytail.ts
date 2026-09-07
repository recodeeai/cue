import type { AgentKind, ResolvedProfile } from "../../profiles/_types";
import { loadProfile } from "./profile-loader";

/** Add only Ponytail's skills and guidance, never its inherited core settings. */
export async function withCodexPonytail(
  profile: ResolvedProfile,
  agent: AgentKind,
): Promise<ResolvedProfile> {
  if (agent !== "codex") return profile;

  const defaults = await loadProfile("ponytail");
  const guidance = defaults.persona.trim();
  const source = defaults.skills.npx.find((entry) => entry.repo === "DietrichGebert/ponytail");
  if (!source) throw new Error("Ponytail profile is missing its upstream skill source");
  const existing = profile.skills.npx.find((entry) =>
    entry.repo === source.repo && (!entry.agents || entry.agents.includes(agent)),
  );
  const npx = existing
    ? profile.skills.npx.map((entry) => entry === existing
      ? { ...entry, skills: [...new Set([...entry.skills, ...source.skills])] }
      : entry)
    : [...profile.skills.npx, source];

  return {
    ...profile,
    skills: { ...profile.skills, npx },
    persona: profile.persona.includes(guidance)
      ? profile.persona
      : [profile.persona, guidance].filter(Boolean).join("\n\n"),
  };
}
