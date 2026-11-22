// Only same-site paths survive, so a crafted link cannot send a signed-in
// member to another origin.
export function callbackUrlFrom(value: string | string[] | undefined) {
  const requested = Array.isArray(value) ? value[0] : value;
  return requested?.startsWith("/") &&
    !requested.startsWith("//") &&
    !requested.startsWith("/\\")
    ? requested
    : "/";
}
