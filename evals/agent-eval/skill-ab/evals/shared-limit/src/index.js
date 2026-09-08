export function parseLimit(value) {
  return Number(value) || 20;
}
export const listLimit = (value) => parseLimit(value);
export const searchLimit = (value) => parseLimit(value);
