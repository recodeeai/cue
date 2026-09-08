/** Reconcile only registrations Cue inserted; identical pre-existing hooks stay external. */
type HookMap = Record<string, unknown[]>;
interface HookDocument extends Record<string, unknown> { hooks: HookMap }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hookMap(value: unknown): HookMap {
  if (!record(value) || Object.values(value).some((entries) => !Array.isArray(entries))) {
    throw new TypeError("Invalid Codex hooks map (expected event arrays)");
  }
  return value as HookMap;
}

function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${key(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function reconcileCodexHooks(raw = "{}", ownedRaw?: string, desired: unknown = {}) {
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed)) throw new TypeError("Invalid Codex hooks.json document");
  const hooks = hookMap(parsed.hooks === undefined ? {} : parsed.hooks);
  const wanted = hookMap(desired);
  let previous: HookMap = {};
  if (ownedRaw !== undefined) {
    const manifest: unknown = JSON.parse(ownedRaw);
    if (!record(manifest) || manifest.version !== 1) throw new TypeError("Invalid .cue-hooks.json ownership manifest");
    previous = hookMap(manifest.hooks);
  }
  const owned: HookMap = {};
  for (const event of new Set([...Object.keys(previous), ...Object.keys(wanted)])) {
    const old = new Set((previous[event] ?? []).map(key));
    const next = new Map((wanted[event] ?? []).map((entry) => [key(entry), entry]));
    const retained = (hooks[event] ?? []).filter((entry) => {
      const id = key(entry);
      if (!old.has(id) || next.has(id)) return true;
      old.delete(id); // Remove one owned copy, not identical external copies.
      return false;
    });
    const present = new Set(retained.map(key));
    const inserted: unknown[] = [];
    for (const [id, entry] of next) {
      if (!present.has(id)) { retained.push(entry); inserted.push(entry); }
      else if (old.has(id)) inserted.push(entry);
    }
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
    if (inserted.length > 0) owned[event] = inserted;
  }
  return { document: { ...parsed, hooks } as HookDocument, owned: { version: 1, hooks: owned } };
}
