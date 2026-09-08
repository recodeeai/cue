import { describe, expect, test } from "bun:test";
import { parseShareRef } from "../../src/lib/shared-profiles";

import { profileInstallCommand } from "./profile-source.js";

describe("profileInstallCommand", () => {
  test.each([
    ["https://github.com/alice/profiles", "cue share install alice/profiles"],
    ["https://github.com/alice/profiles/", "cue share install alice/profiles"],
    ["https://github.com/alice/profiles/tree/main", "cue share install alice/profiles@main"],
    ["https://github.com/alice/profiles/tree/a1b2c3/profiles/reviewer", "cue share install alice/profiles@a1b2c3:profiles/reviewer"],
  ])("derives an install command from %s", (url, command) => {
    expect(profileInstallCommand(url)).toBe(command);
    expect(parseShareRef(command.replace("cue share install ", ""))).not.toBeNull();
  });

  test.each([
    undefined, null, "", "alice/profiles", "http://github.com/alice/profiles",
    "https://example.com/alice/profiles", "https://github.com.evil.test/alice/profiles",
    "https://user@github.com/alice/profiles", "https://github.com:443/alice/profiles",
    "https://github.com/alice/profiles?ref=main", "https://github.com/alice/profiles#main",
    "https://github.com/alice/profiles/tree", "https://github.com/alice/profiles/blob/main/profile.yaml",
    "https://github.com/alice/profiles/tree/main/../other", "https://github.com/alice/profiles/tree/main/./other",
    "https://github.com/alice/profiles/tree/main/%2e%2e/other", "https://github.com/alice/profiles/tree/feature%2Fbranch",
    "https://github.com/alice/profiles/tree/-main", "https://github.com/alice/profiles/tree/main..other",
    "https://github.com/alice/profiles/tree/main/path;whoami", "https://github.com/alice/profiles/tree/main/$(whoami)",
    "https://github.com/alice/profiles/tree/main/a\\b", "https://github.com/alice/profiles\n",
    "https://github.com/alice/.hidden", "https://github.com/alice/profiles/tree/main/.hidden",
    "https://github.com/alice/profiles/tree/main//",
  ])("refuses missing, ambiguous, or unsafe sources: %s", (url) => {
    expect(profileInstallCommand(url)).toBeNull();
  });
});
