import { describe, expect, it } from "vitest";
import {
  kernelProfileNameForLogin,
  kernelProfileNameForWorkspace,
} from "./kernel-profile";

describe("Kernel profile names", () => {
  it("derives opaque, stable, workspace-specific profile names", () => {
    const workspace = "personal:+15555550123";
    const profileName = kernelProfileNameForWorkspace(workspace);

    expect(profileName).toBe(kernelProfileNameForWorkspace(workspace));
    expect(profileName).toMatch(/^openinstinct-[a-f0-9]{40}$/);
    expect(profileName).not.toContain("15555550123");
    expect(profileName).not.toBe(
      kernelProfileNameForWorkspace("personal:+15555550124")
    );
  });

  it("keeps the workspace profile name that saved sign-ins already use", () => {
    expect(kernelProfileNameForWorkspace("personal:+15555550123")).toBe(
      "openinstinct-3cac6451961b3b17fe39e77af1d43914635bd4f5"
    );
  });

  it("gives each saved login of each workspace a profile of its own", () => {
    const workspace = "personal:better-auth:owner-1";
    const login = kernelProfileNameForLogin(workspace, "login-1");

    expect(login).toBe(kernelProfileNameForLogin(workspace, "login-1"));
    expect(login).toMatch(/^openinstinct-[a-f0-9]{40}$/);
    expect(login).not.toContain("owner-1");
    expect(login).not.toContain("login-1");
    expect(login).not.toBe(kernelProfileNameForWorkspace(workspace));
    expect(login).not.toBe(kernelProfileNameForLogin(workspace, "login-2"));
    expect(login).not.toBe(
      kernelProfileNameForLogin("personal:better-auth:owner-2", "login-1")
    );
  });
});
