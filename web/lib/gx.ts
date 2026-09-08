import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WorkspaceError } from "./workspace-schema.js";

function key(secret: string) {
  if (secret.length < 32) throw new WorkspaceError(503, "GX_NOT_CONFIGURED", "Repository encryption is not configured.");
  return Buffer.from(hkdfSync("sha256", secret, "cuecards", "workspace-github-credentials-v1", 32));
}
export function encryptCredential(token: string, context: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64url")).join(".");
}
export function decryptCredential(value: string, context: string, secret: string): string {
  const [iv, tag, encrypted] = value.split(".").map(s => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
export function webhookSecret(id: string, secret: string): string {
  return createHmac("sha256", key(secret)).update("webhook:" + id).digest("hex");
}
export function verifyWebhook(body: Buffer, signature: string, secret: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

const slug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const repoSchema = z.object({
  id: z.number().int().positive(), full_name: slug, default_branch: z.string().min(1),
  permissions: z.object({ admin: z.boolean() }), allow_auto_merge: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
});
const protectionSchema = z.object({
  enforce_admins: z.object({ enabled: z.literal(true) }),
  required_status_checks: z.object({ strict: z.literal(true), contexts: z.array(z.string()).optional(), checks: z.array(z.object({ context: z.string() })).optional() })
    .refine(v => (v.contexts?.length ?? 0) + (v.checks?.length ?? 0) > 0),
  required_pull_request_reviews: z.object({
    required_approving_review_count: z.number().min(1), dismiss_stale_reviews: z.literal(true),
    bypass_pull_request_allowances: z.object({
      users: z.array(z.unknown()).max(0), teams: z.array(z.unknown()).max(0), apps: z.array(z.unknown()).max(0),
    }).optional(),
  }),
});

export class GitHubRepo {
  constructor(private token: string, private request: typeof fetch = fetch) {}

  async api(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request("https://api.github.com/" + path, {
        method, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { authorization: "Bearer " + this.token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "cuecards-workspaces" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new WorkspaceError(502, "GITHUB_UNAVAILABLE", "GitHub could not be reached. Please retry."); }
    if (!response.ok) throw new WorkspaceError(502, "GITHUB_REQUEST_FAILED", "GitHub rejected the request. Check repository permissions, token expiry and rate limits.");
    return response.status === 204 ? null : response.json();
  }

  async repository(fullName: string, expectedId?: number) {
    if (!slug.safeParse(fullName).success) throw new WorkspaceError(400, "INVALID_REPOSITORY", "Use owner/repository.");
    const parsed = repoSchema.safeParse(await this.api("repos/" + fullName));
    if (!parsed.success || !parsed.data.permissions.admin || (expectedId !== undefined && parsed.data.id !== expectedId)) {
      throw new WorkspaceError(403, "REPOSITORY_ADMIN_REQUIRED", "A repository administrator must connect this repository.");
    }
    return parsed.data;
  }

  async gates(fullName: string, id: number) {
    const repo = await this.repository(fullName, id);
    let protection: unknown;
    try { protection = await this.api(`repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}/protection`); }
    catch { throw new WorkspaceError(409, "MERGE_GATES_REQUIRED", "Cannot verify branch protection. Required checks, strict updates, stale-review dismissal and an approving review must apply to admins too."); }
    if (!protectionSchema.safeParse(protection).success) throw new WorkspaceError(409, "MERGE_GATES_REQUIRED", "Protect the default branch: require CI, up-to-date branches, an approving review, dismiss stale approvals and enforce for admins.");
    if (!repo.allow_auto_merge || !repo.allow_squash_merge) throw new WorkspaceError(409, "AUTO_MERGE_DISABLED", "Enable native auto-merge and squash merging in GitHub repository settings first.");
    return repo;
  }

  async queue(fullName: string, id: number, number: number): Promise<"queued" | "skipped"> {
    const repo = await this.gates(fullName, id);
    const pull = z.object({
      node_id: z.string(), state: z.string(), draft: z.boolean(),
      base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }),
      head: z.object({ repo: z.object({ id: z.number() }).nullable() }),
      auto_merge: z.unknown().optional(),
    }).parse(await this.api(`repos/${repo.full_name}/pulls/${number}`));
    if (pull.state !== "open" || pull.draft || pull.base.ref !== repo.default_branch || pull.base.repo.id !== id || pull.head.repo?.id !== id) return "skipped";
    if (pull.auto_merge) return "queued";
    const response = z.object({ data: z.object({ enablePullRequestAutoMerge: z.object({ pullRequest: z.object({ id: z.string() }) }) }).optional(), errors: z.array(z.unknown()).optional() }).safeParse(await this.api("graphql", "POST", {
      query: "mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{id}}}",
      variables: { id: pull.node_id },
    }));
    if (!response.success || response.data.errors?.length || !response.data.data) throw new WorkspaceError(502, "AUTO_MERGE_FAILED", "GitHub could not queue this pull request. Check its mergeability and repository policy.");
    return "queued";
  }
}
