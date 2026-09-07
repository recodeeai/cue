import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config-paths";
import { debug } from "./debug-log";

/** Parse the shared default-profile format: comments, lines and + compositions. */
export function parseDefaultSelector(raw: string): string {
  const extras = raw
    .split(/[\n+]/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  return [...new Set(["core", ...extras])].join("+");
}

/** Missing defaults always fall back to the portable core profile. */
export function getDefaultSelector(
  configDirPath: string = configDir(),
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string {
  try {
    return parseDefaultSelector(readFile(join(configDirPath, "default-profile")));
  } catch (err) {
    debug("launch:default-profile", err);
    return "core";
  }
}
