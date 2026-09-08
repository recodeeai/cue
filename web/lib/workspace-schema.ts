import { z } from "zod";

const workspaceId = z.uuid();
const userId = z.string().min(1).max(128);
const role = z.enum(["admin", "member"]);
export const workspaceAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), name: z.string().trim().min(1).max(80) }),
  z.strictObject({ action: z.literal("invite"), workspaceId, role }),
  z.strictObject({ action: z.literal("acceptInvite"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  z.strictObject({ action: z.literal("revokeInvite"), workspaceId, inviteId: z.uuid() }),
  z.strictObject({ action: z.literal("removeMember"), workspaceId, userId }),
  z.strictObject({ action: z.literal("setRole"), workspaceId, userId, role }),
  z.strictObject({ action: z.literal("connectRepo"), workspaceId, repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), token: z.string().regex(/^[A-Za-z0-9_]+$/).min(20).max(255) }),
  z.strictObject({ action: z.literal("disconnectRepo"), workspaceId, repositoryId: z.uuid() }),
  z.strictObject({ action: z.literal("setAutoMerge"), workspaceId, repositoryId: z.uuid(), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("queuePull"), workspaceId, repositoryId: z.uuid(), number: z.number().int().positive().max(2147483647) }),
]);
export const workspaceQuery = z.strictObject({ id: workspaceId.optional() });
export type WorkspaceAction = z.infer<typeof workspaceAction>;
export type WorkspaceRole = "owner" | "admin" | "member";

export class WorkspaceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
