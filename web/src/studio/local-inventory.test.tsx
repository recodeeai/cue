/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryContent, selectInventoryItems } from "./LocalInventory";
import type { LocalInventoryData } from "../../../src/lib/local-inventory-types";

const data: LocalInventoryData = {
  scannedAt: "2026-09-08T12:00:00Z", sources: [{ path: "/local/skills", state: "scanned" }],
  items: [
    { id: "p", kind: "profile", name: "backend", description: "APIs", state: "installed", sources: ["/profiles/backend"], related: ["s"] },
    { id: "s", kind: "skill", name: "ponytail", description: "Keep it simple", state: "installed", sources: ["/local/skills"], related: ["p"] },
    { id: "m", kind: "mcp", name: "missing", description: "Reference", state: "referenced", sources: [], related: [] },
  ],
};
test("inventory filters by kind, metadata, source and unresolved state", () => {
  expect(selectInventoryItems(data.items, "skill", "SIMPLE", "all").map(x => x.id)).toEqual(["s"]);
  expect(selectInventoryItems(data.items, "all", "/local", "all").map(x => x.id)).toEqual(["s"]);
  expect(selectInventoryItems(data.items, "all", "", "referenced").map(x => x.id)).toEqual(["m"]);
  expect(selectInventoryItems(data.items, "mcp", "ponytail", "all")).toEqual([]);
  expect(selectInventoryItems(data.items, "all", "", "local").map(x => x.id)).toEqual(["p", "s"]);
});
test("local landing is an accessible inventory, not the old feature rail", () => {
  const html = renderToStaticMarkup(<InventoryContent data={data} refreshing={false} onRefresh={() => {}} onAdvanced={() => {}} />);
  expect(html).toContain("Your local toolkit");
  expect(html).toContain('aria-label="Search local inventory"');
  expect(html).toContain("Profiles");
  expect(html).toContain("Skills");
  expect(html).toContain("MCPs");
  expect(html).toContain("Advanced tools");
  expect(html).not.toContain("Marketplace");
  expect(html).not.toContain("gates pass");
});
