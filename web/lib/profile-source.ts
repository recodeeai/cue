/** Only derive shell-safe share references from unambiguous GitHub source URLs. */
export function profileInstallCommand(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  // Validate raw text: URL normalization would hide traversal or encoded separators.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)(?:\/tree\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/([A-Za-z0-9._/-]+))?)?\/?$/.exec(sourceUrl);
  if (!match || match[0] !== sourceUrl) return null;
  const [, owner, repo, ref, rawPath] = match;
  const path = rawPath?.replace(/\/$/, "");
  const segment = (value: string) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);
  if (!segment(repo!) || ref?.includes("..") || (rawPath && !path)) return null;
  if (path?.split("/").some((part) => !segment(part))) return null;
  return `cue share install ${owner}/${repo}${ref ? `@${ref}` : ""}${path ? `:${path}` : ""}`;
}
