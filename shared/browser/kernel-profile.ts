import { createHash } from "node:crypto";

// Kernel profile names are opaque hashes, so Kernel learns neither the
// workspace nor the login. The workspace name must never change: it holds the
// sign-ins already saved by interactive and scheduled browsers.
export function kernelProfileNameForWorkspace(workspaceId: string) {
  return opaqueProfileName(`kernel-profile\0${workspaceId}`);
}

// A site task pinned to a saved login keeps that login's cookies in a profile
// of its own, so two accounts on one portal never share a session. The
// distinct prefix keeps it from ever naming a workspace profile.
export function kernelProfileNameForLogin(
  workspaceId: string,
  loginId: string
) {
  return opaqueProfileName(`kernel-login-profile\0${workspaceId}\0${loginId}`);
}

function opaqueProfileName(input: string) {
  return `openinstinct-${createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 40)}`;
}
