/** True for an absolute HTTP(S) URL without credentials, query, or fragment. */
export function isPlainHttpUrl(
  value: string,
  options: { httpsOnly?: boolean; originOnly?: boolean } = {},
): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (options.httpsOnly ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol)) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (!options.originOnly || url.pathname === "/")
  );
}
