import { expect, test } from "bun:test";
import { handleWorkspaces } from "./workspace-http.js";
import type { Workspaces } from "./workspaces.js";

let calls = 0;
const service = {
  list: async () => { calls++; return []; },
  mutate: async () => { calls++; return { id: "created" }; },
} as unknown as Workspaces;
const dependencies = { service, getUser: async () => "alice", origins: ["https://cuecards.cc"] };
const request = (body: string, headers: Record<string, string> = {}) => new Request("https://cuecards.cc/api/v1/workspaces", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body,
});
test("auth precedes business logic and every response is private/no-store", async () => {
  calls = 0;
  const response = await handleWorkspaces(new Request("https://cuecards.cc/api/v1/workspaces"), { ...dependencies, getUser: async () => null });
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(calls).toBe(0);
});
test("cookie mutation requires exact trusted origin; forged host cannot grant trust", async () => {
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { host: "evil.example", origin: "https://evil.example" }, { cookie: "session=x", authorization: "Bearer x" }]) {
    expect((await handleWorkspaces(request('{"action":"create","name":"Team"}', headers), dependencies)).status).toBe(403);
  }
  expect((await handleWorkspaces(request('{"action":"create","name":"Team"}', { origin: "https://cuecards.cc" }), dependencies)).status).toBe(200);
});
test("malformed JSON, schemas, overlong streamed bodies and bad queries are rejected", async () => {
  calls = 0;
  for (const body of ["{", '{"action":"create","name":"x","role":"owner"}', '{"action":"create","name":""}']) {
    expect((await handleWorkspaces(request(body, { origin: "https://cuecards.cc" }), dependencies)).status).toBe(400);
  }
  expect((await handleWorkspaces(request(" ".repeat(65537), { origin: "https://cuecards.cc" }), dependencies)).status).toBe(413);
  expect((await handleWorkspaces(new Request("https://cuecards.cc/api/v1/workspaces?id=bad"), dependencies)).status).toBe(400);
  expect(calls).toBe(0);
});
test("internal errors do not leak credentials or SQL", async () => {
  const response = await handleWorkspaces(new Request("https://cuecards.cc/api/v1/workspaces"), {
    ...dependencies, getUser: async () => { throw new Error("secret database password"); },
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("password");
});
