export function buildUrl(path, params) {
  return path + "?" + Object.entries(params).map(([key, value]) => key + "=" + value).join("&");
}
