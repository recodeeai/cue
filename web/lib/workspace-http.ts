import { workspaceAction, workspaceQuery, WorkspaceError } from "./workspace-schema.js";
import type { Workspaces } from "./workspaces.js";

export async function handleWorkspaces(req: Request, deps: {
  service: Workspaces;
  getUser: (headers: Headers) => Promise<string | null>;
  origins: string[];
}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
  try {
    if (!["GET", "POST"].includes(req.method)) throw new WorkspaceError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
    const userId = await deps.getUser(req.headers);
    if (!userId) throw new WorkspaceError(401, "UNAUTHORIZED", "Sign in to continue.");
    const url = new URL(req.url);
    if (req.method === "GET") {
      const query = workspaceQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) throw new WorkspaceError(400, "INVALID_INPUT", "Invalid workspace query.");
      return json({ ok: true, data: query.data.id ? await deps.service.detail(userId, query.data.id) : await deps.service.list(userId) });
    }
    const origin = req.headers.get("origin");
    const tokenOnly = !req.headers.has("cookie") && (/^Bearer \S+$/i.test(req.headers.get("authorization") ?? "") || !!req.headers.get("x-api-key"));
    if (origin ? !deps.origins.includes(origin) : !tokenOnly) throw new WorkspaceError(403, "INVALID_ORIGIN", "This request origin is not allowed.");
    if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new WorkspaceError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new WorkspaceError(413, "BODY_TOO_LARGE", "Request exceeds 64 KiB."); }
        chunks.push(value);
      }
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new WorkspaceError(400, "INVALID_JSON", "Invalid JSON body."); }
    const parsed = workspaceAction.safeParse(input);
    if (!parsed.success) throw new WorkspaceError(400, "INVALID_INPUT", "Invalid workspace action or fields.");
    return json({ ok: true, data: await deps.service.mutate(userId, parsed.data) });
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Workspace service unavailable. Please retry." } }, 500);
  }
}
