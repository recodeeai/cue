export async function withResource(open, action) {
  const resource = await open();
  const result = await action(resource);
  await resource.close();
  return result;
}
