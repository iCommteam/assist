import { ConflictError, NotFoundError } from "@onkernel/sdk";
import type {
  BrowserCreateResponse,
  BrowserRetrieveResponse,
  BrowserUpdateResponse,
} from "@onkernel/sdk/resources/browsers";
import type { SessionContext } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listWorkerBrowserSessions,
  readBrowserSession,
  withBrowserProfileWriteLock,
} from "@db/services/browsers";
import { recordBrowserTraceDomains } from "@db/services/browser-traces";
import { isSiteTaskSession } from "@db/services/sites";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { disposeBrowserLoopSession } from "../lib/semantic-loop";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import {
  domainFromUrl,
  harvestBrowserTraceDomains,
} from "@agent/subagents/browser-agent/lib/trace/domains";
import {
  assertNavigableUrl,
  browserChromePolicy,
  workerNavigationFence,
} from "@agent/subagents/browser-agent/lib/policy/hosts";
import { assertWorkerNotBlocked } from "@agent/subagents/browser-agent/lib/policy/page-check";
import { forgetFilledBrowser } from "@agent/subagents/browser-agent/lib/autofill/redaction";
import { applicationOrigin } from "@shared/environment/origin";
import {
  kernelProfileNameForLogin,
  kernelProfileNameForWorkspace,
} from "@shared/browser/kernel-profile";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";

const browserTimeoutFloorSeconds = 15 * 60;
// Idle timeout ceiling: a forgotten browser holding a login dies within an hour.
const browserTimeoutCeilingSeconds = 60 * 60;
// A site task's browsers outlive fill_code_from_site's 20-minute wait for a
// relayed code, whatever the model asks for.
const siteBrowserTimeoutSeconds = 30 * 60;

const unrecordedSiteTaskRefusal =
  'This site task is not recorded as one the site started, so its browsers cannot use the saved login. Wait a few seconds and retry once; if it is refused again, return status "failure" saying the site task could not be confirmed.';
const unpinnedSaveRefusal =
  'This site task is not pinned to a saved login, so its browsers keep no sign-in and cannot be created with save_changes. If the work needs a sign-in, return status "failure" saying the task has no saved login.';

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  save_changes: z.boolean().optional(),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(browserTimeoutCeilingSeconds)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const manageBrowsers = defineTool({
  description:
    'Manage browser sessions backed by a persistent profile: the workspace profile, or in a site task pinned to a saved login, a profile of that login alone. A site task with no pin gets browsers with no profile, which cannot save a sign-in. Create read-only browsers by default so tasks can run in parallel. Immediately before a login, replace that task browser with one created using save_changes: true, then delete it after authentication so the session is saved. Only one profile writer may be active. Use "list" or "get" to inspect the browsers this task created.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const signal = context.abortSignal;

    switch (input.action) {
      case "create": {
        assertWorkerNotBlocked();
        const fence = workerNavigationFence(context.session);
        if (input.start_url) assertNavigableUrl(input.start_url, fence);
        const { initiator } = context.session.auth;
        const site = siteOfSession(initiator);
        const profileName = browserProfileName(scope.workspaceId, initiator);
        if (!profileName && input.save_changes) {
          throw new Error(unpinnedSaveRefusal);
        }
        // A start whose task row was never written still runs in eve, where
        // the site can neither read nor stop it, so it keeps off the login.
        const rootSessionId = context.session.parent?.rootSessionId;
        if (
          site &&
          siteLoginOfSession(initiator) &&
          !(
            rootSessionId &&
            (await isSiteTaskSession(site, scope, rootSessionId))
          )
        ) {
          throw new Error(unrecordedSiteTaskRefusal);
        }
        const create = async () => {
          const profile = profileName
            ? await ensureProfile(profileName, signal)
            : undefined;
          if (profile && input.save_changes) {
            const activeWriter = await findActiveProfileWriter(
              profile.id,
              signal
            );
            if (activeWriter) {
              throw new Error(
                site
                  ? `Browser session ${activeWriter.session_id} is already saving login state for this browser profile. Retry after it finishes.`
                  : `Browser session ${activeWriter.session_id} is already saving login state for this browser profile. Retry after it finishes; if the task that opened it has ended, delete it with manage_browsers first.`
              );
            }
          }
          // Stealth stays off: it is the only switch for Kernel's CAPTCHA
          // solver, and without it egress is direct (no stealth proxy). No
          // retries: a create that is retried after a lost response orphans a
          // browser, possibly a logged-in one.
          const browser = await kernel.browsers.create(
            {
              chrome_policy: browserChromePolicy(fence),
              kiosk_mode: true,
              profile: profile
                ? { id: profile.id, save_changes: input.save_changes ?? false }
                : undefined,
              start_url: input.start_url,
              stealth: false,
              telemetry: {
                browser: { page: { enabled: true } },
                enabled: true,
              },
              timeout_seconds: site
                ? siteBrowserTimeoutSeconds
                : (input.timeout_seconds ?? browserTimeoutFloorSeconds),
              viewport: browserViewport(input),
            },
            { maxRetries: 0, signal }
          );
          try {
            await createBrowserSession(scope, {
              createdAt: browser.created_at,
              sessionId: browser.session_id,
              workerSessionId: context.session.id,
            });
          } catch (error) {
            await kernel.browsers
              .deleteByID(browser.session_id, { signal })
              .catch(() => undefined);
            throw error;
          }
          const startDomain = input.start_url
            ? domainFromUrl(input.start_url)
            : undefined;
          if (startDomain) {
            await recordBrowserTraceDomains(scope, context.session.id, [
              startDomain,
            ]).catch(() => undefined);
          }
          return lifecycleResult(browser);
        };
        return profileName && input.save_changes
          ? withBrowserProfileWriteLock(profileName, create)
          : create();
      }
      case "list": {
        const records = await listWorkerBrowserSessions(
          scope,
          context.session.id
        );
        const includeDeleted = input.status !== "active";
        const browsers = await Promise.all(
          records.map(async ({ sessionId }) => {
            try {
              const browser = await kernel.browsers.retrieve(
                sessionId,
                { include_deleted: includeDeleted },
                { signal }
              );
              const value = browserDescriptor(browser);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch (error) {
              if (isNotFoundError(error)) {
                await deleteBrowserSession(scope, sessionId);
              }
              return null;
            }
          })
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          has_more: false,
          items: browsers
            .filter((browser) => browser !== null)
            .slice(offset, offset + limit),
          next_offset: null,
        };
      }
      case "get": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, context.session, sessionId);
        return browserDescriptor(
          await retrieveBrowser(scope, sessionId, signal)
        );
      }
      case "update": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, context.session, sessionId);
        const viewport = browserViewport(input);
        const browser = viewport
          ? await kernel.browsers.update(sessionId, { viewport }, { signal })
          : await retrieveBrowser(scope, sessionId, signal);
        return lifecycleResult(browser);
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        const record = await deletableBrowserSession(
          scope,
          context.session,
          sessionId,
          signal
        );
        await harvestBrowserTraceDomains(
          scope,
          record.workerSessionId ?? context.session.id,
          { createdAt: record.createdAt, sessionId: record.sessionId },
          signal
        );
        await disposeBrowserLoopSession(sessionId);
        await kernel.browsers
          .deleteByID(sessionId, { signal })
          .catch((cause: unknown) => {
            if (!isNotFoundError(cause)) throw cause;
          });
        await deleteBrowserSession(scope, sessionId);
        forgetFilledBrowser(sessionId);
        return "Browser session deleted successfully";
      }
    }
    throw new Error("Unsupported browser management action.");
  },
});

export default manageBrowsers;

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

async function retrieveBrowser(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  sessionId: string,
  signal?: AbortSignal
) {
  try {
    return await kernel.browsers.retrieve(sessionId, {}, { signal });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await disposeBrowserLoopSession(sessionId);
    await deleteBrowserSession(scope, sessionId);
    throw new Error(
      "Browser session no longer exists. Its stale record was removed; create a fresh browser instead of retrying this session ID.",
      { cause: error }
    );
  }
}

function isNotFoundError(cause: unknown) {
  return z.object({ status: z.literal(404) }).safeParse(cause).success;
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

type KernelBrowser =
  | BrowserCreateResponse
  | BrowserRetrieveResponse
  | BrowserUpdateResponse;

// Kernel's live-view URL controls the browser, so it never reaches a model or
// the chat. The handoff link opens it only for the signed-in owner.
function browserHandoffUrl(sessionId: string) {
  return new URL(
    `/browsers/${encodeURIComponent(sessionId)}/live`,
    applicationOrigin()
  ).toString();
}

function browserDescriptor(browser: KernelBrowser) {
  return {
    handoff_url: browserHandoffUrl(browser.session_id),
    session_id: browser.session_id,
    status: browser.deleted_at ? "deleted" : "active",
    viewport: browser.viewport ?? undefined,
  };
}

function lifecycleResult(browser: KernelBrowser) {
  const value = browserDescriptor(browser);
  return {
    browser: value,
    next_actions: [
      `Call browser_snapshot with session_id "${value.session_id}" to mint current refs; use browser_find or browser_text to narrow large pages.`,
      `Then use browser_act with session_id "${value.session_id}" for short ref-based click, fill, and submit plans; inspect its successor state instead of waiting on per-action postconditions. Use browser_navigate to open another URL in the same browser.`,
      `Use computer_action with session_id "${value.session_id}" only when visual reasoning or coordinate control is necessary.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
  };
}

// A worker deletes only its own browsers, with one exception outside site
// tasks: a sign-in browser that another worker of the workspace left saving
// to the workspace profile, which blocks every later sign-in there until it
// idles out. Such a browser can be deleted, never read or driven.
async function deletableBrowserSession(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  session: Pick<SessionContext["session"], "auth" | "id">,
  sessionId: string,
  signal: AbortSignal | undefined
) {
  try {
    return await requireOwnedBrowserSession(scope, session, sessionId);
  } catch (error) {
    if (siteOfSession(session.auth.initiator)) throw error;
    const record = await readBrowserSession(scope, sessionId);
    if (!record) throw error;
    const [browser, profile] = await Promise.all([
      kernel.browsers.retrieve(sessionId, {}, { signal }),
      kernel.profiles.retrieve(
        kernelProfileNameForWorkspace(scope.workspaceId),
        {
          signal,
        }
      ),
    ]).catch(() => {
      throw error;
    });
    if (!browser.profile_save_changes || browser.profile?.id !== profile.id) {
      throw error;
    }
    return record;
  }
}

// The Kernel profile a session's browsers keep cookies in. A site task without
// a pin gets none: the workspace profile holds the owner's own sign-ins, and a
// page the task reaches must neither use nor change them.
function browserProfileName(
  workspaceId: string,
  initiator: Parameters<typeof siteOfSession>[0]
) {
  const login = siteLoginOfSession(initiator);
  if (login) return kernelProfileNameForLogin(workspaceId, login.id);
  return siteOfSession(initiator)
    ? undefined
    : kernelProfileNameForWorkspace(workspaceId);
}

async function ensureProfile(name: string, signal?: AbortSignal) {
  try {
    return await kernel.profiles.retrieve(name, { signal });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }

  try {
    return await kernel.profiles.create({ name }, { signal });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return kernel.profiles.retrieve(name, { signal });
  }
}

async function findActiveProfileWriter(
  profileId: string | undefined,
  signal: AbortSignal | undefined
) {
  if (!profileId) return undefined;
  for await (const browser of kernel.browsers.list(
    { query: profileId, status: "active" },
    { signal }
  )) {
    if (browser.profile?.id === profileId && browser.profile_save_changes) {
      return browser;
    }
  }
  return undefined;
}
