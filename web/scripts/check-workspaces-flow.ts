import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.BASE ?? "http://localhost:3000";
// This writes test accounts/workspaces. Refuse production by default.
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Use a disposable local server for this check.");
const password = randomUUID() + "aA1!";
async function signup(name: string) {
  const response = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email: randomUUID() + "@example.test", password }),
  });
  assert.equal(response.status, 200, "signup must work with the installed auth migration/runtime");
  const cookies = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.ok(cookies, "session cookie is required");
  return cookies;
}
async function call(cookie: string, action?: Record<string, unknown>, id?: string, expected = 200) {
  const response = await fetch(base + "/api/v1/workspaces" + (id ? "?id=" + id : ""), {
    method: action ? "POST" : "GET", headers: { cookie, origin: base, "content-type": "application/json" },
    ...(action ? { body: JSON.stringify(action) } : {}),
  });
  assert.equal(response.status, expected);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return response.json();
}
const alice = await signup("Workspace check owner"), bob = await signup("Workspace check member");
const list = await call(alice);
assert.equal(list.data.filter((w: { kind: string }) => w.kind === "personal").length, 1);
const created = await call(alice, { action: "create", name: "HTTP check team" });
const id = created.data.id;
await call(bob, undefined, id, 404);
await call("", undefined, id, 401);
const invite = await call(alice, { action: "invite", workspaceId: id, role: "member" });
await call(bob, { action: "acceptInvite", token: invite.data.token });
await call(bob, { action: "acceptInvite", token: invite.data.token }, undefined, 410);
assert.equal((await call(bob, undefined, id)).data.workspace.role, "member");
await call(bob, { action: "invite", workspaceId: id, role: "admin" }, undefined, 403);
console.log("PASS: real signup/session, personal workspace, tenant isolation, invite acceptance/replay and privilege checks");
