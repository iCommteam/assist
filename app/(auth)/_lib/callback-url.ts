// Only same-site paths survive, so a crafted link cannot send a signed-in
// member to another origin. The value is parsed the way the browser parses a
// link (tabs and newlines dropped, backslashes read as slashes, dot segments
// resolved), and the parsed form is returned, so the redirect and the router
// cannot read it differently.
const base = "http://callback.invalid";

export function callbackUrlFrom(value: string | string[] | undefined) {
  const requested = Array.isArray(value) ? value[0] : value;
  const resolved = requested?.startsWith("/")
    ? URL.parse(requested, base)
    : null;
  if (resolved?.origin !== base) return "/";
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // "/.//evil.example" resolves on this origin to "//evil.example", which is
  // itself a link to another origin.
  return path.startsWith("//") ? "/" : path;
}
