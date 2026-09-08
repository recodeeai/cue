export function patchSettings(current, patch) {
  return { ok: true, value: Object.assign(current, patch) };
}
