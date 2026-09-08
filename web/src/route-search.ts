import { z } from "zod";
import type { View } from "./studio/StudioApp";

const views: View[] = ["inventory", "welcome", "explorer", "dashboard", "profiles", "search", "merge", "workflows", "mcps", "plugins", "market", "hooks", "permissions", "env", "api", "settings"];
export function parseStudioView(value: unknown): View | undefined {
  return typeof value === "string" && views.includes(value as View) ? value as View : undefined;
}
export function parseWorkspaceSearch(raw: Record<string, unknown>): { workspace?: string } {
  const parsed = z.uuid().safeParse(raw.workspace);
  return { workspace: parsed.success ? parsed.data : undefined };
}
