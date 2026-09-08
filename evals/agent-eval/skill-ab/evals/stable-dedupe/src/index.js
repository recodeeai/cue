export function uniqueBy(items, keyOf) {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}
