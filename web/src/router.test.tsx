import { expect, test } from "bun:test";
import { parseStudioView, parseWorkspaceSearch } from "./route-search";

test("studio deep links accept supported views and reject arbitrary values", () => {
  expect(parseStudioView("inventory")).toBe("inventory");
  expect(parseStudioView("dashboard")).toBe("dashboard");
  expect(parseStudioView("__proto__")).toBeUndefined();
  expect(parseStudioView(["api"])).toBeUndefined();
});
test("workspace URLs reject malformed or non-UUID IDs", () => {
  expect(parseWorkspaceSearch({workspace:"1975ee71-0ef7-44be-922e-5384e7d51651"}).workspace).toBe("1975ee71-0ef7-44be-922e-5384e7d51651");
  expect(parseWorkspaceSearch({workspace:"------------------------------------"}).workspace).toBeUndefined();
});
