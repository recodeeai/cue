import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptCredential, encryptCredential, verifyWebhook, webhookSecret, GitHubRepo } from "./gx.js";

test("credentials are authenticated, context-bound and never plaintext", () => {
  const secret = randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
  const encrypted = encryptCredential(token, "workspace:repo", secret);
  expect(encrypted).not.toContain(token);
  expect(decryptCredential(encrypted, "workspace:repo", secret)).toBe(token);
  expect(() => decryptCredential(encrypted, "other:repo", secret)).toThrow();
  expect(() => decryptCredential(encrypted, "workspace:repo", randomBytes(32).toString("hex"))).toThrow();
  expect(verifyWebhook(Buffer.from("{}"), "sha256=bad", webhookSecret("repo", secret))).toBe(false);
});

function githubMock(protection: unknown, pull: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (init?.method === "POST") writes.push(url);
    const data = url.endsWith("/protection") ? protection
      : url.includes("/pulls/") ? { node_id: "PR_1", state: "open", draft: false, base: { ref: "main", repo: { id: 1 } }, head: { repo: { id: 1 } }, auto_merge: null, ...pull }
      : url.endsWith("/graphql") ? { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } } }
      : { id: 1, full_name: "owner/repo", name: "repo", owner: { login: "owner" }, default_branch: "main", permissions: { admin: true }, allow_auto_merge: true, allow_squash_merge: true };
    return Response.json(data);
  };
  return { client: new GitHubRepo("credential", request as typeof fetch), writes };
}
const gates = { enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ["test"] }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true } };
test("auto merge refuses missing gates and never writes", async () => {
  for (const protection of [{}, { ...gates, enforce_admins: { enabled: false } }, { ...gates, required_status_checks: null }, { ...gates, required_pull_request_reviews: { required_approving_review_count: 0 } }]) {
    const { client, writes } = githubMock(protection);
    await expect(client.queue("owner/repo", 1, 12)).rejects.toMatchObject({ code: "MERGE_GATES_REQUIRED" });
    expect(writes).toHaveLength(0);
  }
});
test("auto merge excludes forks, drafts and non-default branches", async () => {
  for (const pull of [{ draft: true }, { head: { repo: { id: 2 } } }, { base: { ref: "release", repo: { id: 1 } } }, { state: "closed" }]) {
    const { client, writes } = githubMock(gates, pull);
    expect(await client.queue("owner/repo", 1, 12)).toBe("skipped");
    expect(writes).toHaveLength(0);
  }
  const { client, writes } = githubMock(gates);
  expect(await client.queue("owner/repo", 1, 12)).toBe("queued");
  expect(writes).toEqual(["https://api.github.com/graphql"]);
});

test("actors allowed to bypass required reviews prevent auto-enrollment", async () => {
  for (const kind of ["users", "teams", "apps"]) {
    const { client, writes } = githubMock({ ...gates, required_pull_request_reviews: {
      ...gates.required_pull_request_reviews,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [], [kind]: [{ id: 1 }] },
    } });
    await expect(client.queue("owner/repo", 1, 12)).rejects.toMatchObject({ code: "MERGE_GATES_REQUIRED" });
    expect(writes).toHaveLength(0);
  }
});
