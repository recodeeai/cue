import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("public discovery links use cuecards.cc while Pages remains documentation", () => {
  expect(read("../README.md")).toContain("[Community](https://cuecards.cc)");
  expect(read("../README.md")).not.toContain("· [opencue.github.io/cuecards]");
  expect(read("../docs/index.md")).toContain("https://cuecards.cc");
  expect(read("./index.html")).toContain('<link rel="canonical" href="https://cuecards.cc/"');
  expect(read("./index.html")).toContain("Discover and share agent profiles");
  expect(read("./public/robots.txt")).toContain("Sitemap: https://cuecards.cc/sitemap.xml");
  const locations = [...read("./public/sitemap.xml").matchAll(/<loc>(.*?)<\/loc>/g)];
  expect(locations.map((match) => match[1])).toEqual(["https://cuecards.cc/"]);
});

test("profile publication docs include an installable GitHub source", () => {
  const docs = read("../docs/marketplace-api.md");
  expect(docs).toContain("publish profile ship-fast --source-url https://github.com/me/ship-fast");
  expect(docs).toContain('"sourceUrl":"https://github.com/me/ship-fast"');
  expect(docs).toContain("cue share install me/ship-fast");
});
