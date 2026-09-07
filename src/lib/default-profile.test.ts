import { expect, test } from "bun:test";
import { getDefaultSelector, parseDefaultSelector } from "./default-profile";

test("default readers share comment, composite and deduplication semantics", () => {
  const raw = "# ignored\nbackend+core\nresearch # comment\nbackend\n";
  expect(parseDefaultSelector(raw)).toBe("core+backend+research");
  expect(getDefaultSelector("/unused", () => raw)).toBe(parseDefaultSelector(raw));
});

test("empty or unreadable defaults preserve core", () => {
  expect(parseDefaultSelector("\n# comment\n")).toBe("core");
  expect(getDefaultSelector("/unused", () => { throw new Error("missing"); })).toBe("core");
});
