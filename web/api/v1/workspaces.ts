import { auth } from "../../lib/auth.js";
import { resolveAuthBaseUrl } from "../../lib/auth-origin.js";
import { getPool } from "../../lib/db.js";
import { Workspaces } from "../../lib/workspaces.js";
import { handleWorkspaces } from "../../lib/workspace-http.js";

export async function workspaceRequest(request: Request): Promise<Response> {
  return handleWorkspaces(request, {
    service: new Workspaces(getPool()),
    getUser: async headers => (await auth.api.getSession({ headers }))?.user.id ?? null,
    origins: [new URL(resolveAuthBaseUrl()).origin, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map(o => o.trim()) ?? [])],
  });
}

export default { fetch: workspaceRequest };
