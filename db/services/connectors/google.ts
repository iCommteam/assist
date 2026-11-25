import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { and, eq, like, lt } from "drizzle-orm";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  exchangeGoogleCode,
  googleAuthorizeUrl,
  GoogleGrantError,
  googleOAuthClient,
  GoogleUnavailableError,
  newGoogleFlow,
  refreshGoogleToken,
  revokeGoogleToken,
} from "@shared/connectors/google/oauth";
import {
  googleAbilities,
  grantedGoogleAbilities,
} from "@shared/connectors/google/scopes";
import { db, encryptedSecrets } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { ensureScope } from "@db/services/scope";

// A member's Google account, sealed in encrypted_secrets under the connector
// namespace of their own workspace. One row holds the account: its address,
// the scopes Google granted, and its tokens. One row per connect in progress
// holds that flow's PKCE verifier and where it returns, keyed by a hash of
// its state. Nothing here ever returns a token except googleAccessToken, and
// nothing here logs one.
const namespace = "connector";
const accountId = "google";
const flowIdPrefix = "google-flow:";
const flowLifetimeMs = 10 * 60 * 1000;
// A token this close to expiring is refreshed before it is handed out.
const accessTokenMarginMs = 60 * 1000;

const accountSchema = z.object({
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.number().optional(),
  connectedAt: z.string(),
  email: z.string(),
  // Absent once Google refused the grant: the member must connect again.
  refreshToken: z.string().optional(),
  scopes: z.array(z.string()),
  subject: z.string(),
});

type GoogleAccount = z.infer<typeof accountSchema>;

// Where a connect returns: the Workspace page, or a chat's sign-in, which
// eve's own callback route finishes.
const returnToSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings") }),
  z.object({ callbackPath: z.string(), kind: z.literal("chat") }),
]);

export type GoogleConnectReturn = z.infer<typeof returnToSchema>;

const flowSchema = z.object({
  createdAt: z.number(),
  returnTo: returnToSchema,
  verifier: z.string(),
});

// Google refused the stored grant, or the member never connected: only
// connecting again helps.
export class GoogleReconnectNeededError extends Error {
  constructor() {
    super("Connect Google again to continue.");
    this.name = "GoogleReconnectNeededError";
  }
}

// What the Workspace page and the agent may know of a connected account.
export async function googleAccountOf(scope: AccessScope) {
  const account = await readAccount(scope);
  if (!account) return undefined;
  return {
    connectedAt: account.connectedAt,
    email: account.email,
    needsReconnect: account.refreshToken === undefined,
    scopes: account.scopes,
  };
}

export type GoogleAccountSummary = NonNullable<
  Awaited<ReturnType<typeof googleAccountOf>>
>;

// Starts a connect for this member and returns Google's consent URL. Flows
// older than their lifetime are dropped first.
export async function startGoogleConnect(
  scope: AccessScope,
  returnTo: GoogleConnectReturn,
  loginHint: string | undefined
) {
  const client = googleOAuthClient();
  if (!client) throw new Error("Google is not set up on this assist.");
  await ensureScope(scope);
  await dropStaleFlows(scope);
  const flow = newGoogleFlow();
  const createdAt = Date.now();
  await writeSealed(scope, flowId(flow.state), {
    createdAt,
    returnTo,
    verifier: flow.verifier,
  });
  return {
    expiresAt: new Date(createdAt + flowLifetimeMs),
    state: flow.state,
    url: googleAuthorizeUrl(client, flow, loginHint),
  };
}

// Finishes a connect from Google's redirect, for the signed-in member only:
// another member's flow is not found under their workspace. The flow is
// spent on the first attempt, whatever its outcome. A grant that allows
// nothing assist asked for is revoked and not kept; one that allows only
// some of it is kept, and the answer names what is missing.
export async function finishGoogleConnect(
  scope: AccessScope,
  callback: {
    readonly code: string | undefined;
    readonly error: string | undefined;
    readonly state: string | undefined;
  }
) {
  const client = googleOAuthClient();
  if (!client) return { ok: false, reason: "unavailable" } as const;
  if (!callback.state) return { ok: false, reason: "failed" } as const;
  const id = flowId(callback.state);
  const flow = flowSchema.safeParse(await readSealed(scope, id));
  await deleteRow(scope, id);
  if (!flow.success || Date.now() - flow.data.createdAt > flowLifetimeMs) {
    return { ok: false, reason: "expired" } as const;
  }
  const { returnTo, verifier } = flow.data;
  if (callback.error !== undefined) {
    return {
      ok: false,
      reason: callback.error === "access_denied" ? "denied" : "failed",
      returnTo,
    } as const;
  }
  if (!callback.code) return { ok: false, reason: "failed", returnTo } as const;
  let granted: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    granted = await exchangeGoogleCode(client, callback.code, verifier);
  } catch (error) {
    if (
      error instanceof GoogleGrantError ||
      error instanceof GoogleUnavailableError
    ) {
      return { ok: false, reason: "failed", returnTo } as const;
    }
    throw error;
  }
  const allowed = new Set(grantedGoogleAbilities(granted.scopes));
  if (allowed.size === 0) {
    await revokeGoogleToken(granted.refreshToken);
    return { ok: false, reason: "nothing-allowed", returnTo } as const;
  }
  await ensureScope(scope);
  await writeSealed(scope, accountId, {
    accessToken: granted.accessToken,
    accessTokenExpiresAt: granted.accessTokenExpiresAt,
    connectedAt: new Date().toISOString(),
    email: granted.email,
    refreshToken: granted.refreshToken,
    scopes: granted.scopes,
    subject: granted.subject,
  });
  return {
    email: granted.email,
    missing: googleAbilities
      .filter((ability) => !allowed.has(ability.id))
      .map((ability) => ability.id),
    ok: true,
    returnTo,
  } as const;
}

// A live access token for this member's own account, refreshed when it is
// about to expire. Throws GoogleReconnectNeededError when there is no grant
// or Google refused it (the refresh token is then dropped, and the account
// stays listed as needing a reconnect), and GoogleUnavailableError when
// Google could not answer, which drops nothing.
export async function googleAccessToken(scope: AccessScope) {
  const client = googleOAuthClient();
  const account = await readAccount(scope);
  if (!client || !account?.refreshToken) {
    throw new GoogleReconnectNeededError();
  }
  if (
    account.accessToken &&
    account.accessTokenExpiresAt !== undefined &&
    account.accessTokenExpiresAt - Date.now() > accessTokenMarginMs
  ) {
    return issued(account, account.accessToken, account.accessTokenExpiresAt);
  }
  let refreshed: Awaited<ReturnType<typeof refreshGoogleToken>>;
  try {
    refreshed = await refreshGoogleToken(client, account.refreshToken);
  } catch (error) {
    if (error instanceof GoogleGrantError) {
      await requireGoogleReconnect(scope);
      throw new GoogleReconnectNeededError();
    }
    throw error;
  }
  await updateAccount(scope, {
    ...account,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    refreshToken: refreshed.refreshToken ?? account.refreshToken,
    scopes: refreshed.scopes ?? account.scopes,
  });
  return issued(account, refreshed.accessToken, refreshed.accessTokenExpiresAt);
}

// Forgets the cached access token, so the next call refreshes it.
export async function dropGoogleAccessToken(scope: AccessScope) {
  const account = await readAccount(scope);
  if (!account?.accessToken) return;
  await updateAccount(scope, {
    ...account,
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
  });
}

// Drops the tokens Google stopped accepting; the address and scopes stay, so
// the member sees which account to connect again.
async function requireGoogleReconnect(scope: AccessScope) {
  const account = await readAccount(scope);
  if (!account) return;
  await updateAccount(scope, {
    ...account,
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
    refreshToken: undefined,
  });
}

// Revokes the grant at Google and deletes the account and every connect in
// progress. The rows go even when Google could not confirm the revoke, and
// the answer says so. Undefined when nothing was connected.
export async function disconnectGoogle(scope: AccessScope) {
  const account = await readAccount(scope);
  const token = account?.refreshToken ?? account?.accessToken;
  const revoked = token === undefined ? true : await revokeGoogleToken(token);
  await db
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        like(encryptedSecrets.id, "google%")
      )
    );
  return account === undefined ? undefined : { revoked };
}

function issued(account: GoogleAccount, token: string, expiresAt: number) {
  return { expiresAt, providerSubject: account.subject, token };
}

async function readAccount(scope: AccessScope) {
  const account = accountSchema.safeParse(await readSealed(scope, accountId));
  return account.success ? account.data : undefined;
}

// Only an account still stored is updated: a refresh that ends after a
// Disconnect never brings the account back.
async function updateAccount(scope: AccessScope, account: GoogleAccount) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  await db
    .update(encryptedSecrets)
    .set({
      encryptedValue: sealValue(
        secretEncryptionKey,
        scope,
        accountId,
        JSON.stringify(account)
      ),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, accountId)
      )
    );
}

function flowId(state: string) {
  return `${flowIdPrefix}${createHash("sha256").update(state).digest("hex")}`;
}

async function dropStaleFlows(scope: AccessScope) {
  await db
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        like(encryptedSecrets.id, `${flowIdPrefix}%`),
        lt(encryptedSecrets.updatedAt, new Date(Date.now() - flowLifetimeMs))
      )
    );
}

async function deleteRow(scope: AccessScope, id: string) {
  await db
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    );
}

async function readSealed(scope: AccessScope, id: string) {
  const [row] = await db
    .select({ encryptedValue: encryptedSecrets.encryptedValue })
    .from(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    )
    .limit(1);
  if (!row) return undefined;
  const { secretEncryptionKey } = await getInstallationSecrets();
  const opened = openValue(secretEncryptionKey, scope, id, row.encryptedValue);
  if (opened === undefined) return undefined;
  try {
    return z.json().parse(JSON.parse(opened));
  } catch {
    return undefined;
  }
}

async function writeSealed(
  scope: AccessScope,
  id: string,
  value: GoogleAccount | z.infer<typeof flowSchema>
) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const encryptedValue = sealValue(
    secretEncryptionKey,
    scope,
    id,
    JSON.stringify(value)
  );
  const updatedAt = new Date();
  await db
    .insert(encryptedSecrets)
    .values({
      encryptedValue,
      id,
      namespace,
      updatedAt,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      set: { encryptedValue, updatedAt },
      target: [
        encryptedSecrets.workspaceId,
        encryptedSecrets.namespace,
        encryptedSecrets.id,
      ],
    });
}

// AES-256-GCM under a key derived for connector values alone, bound to the
// workspace and the row, so a sealed value copied to another member's row, or
// to another row of the same member, never opens.
const sealPrefix = "c1.";
const ivBytes = 12;
const tagBytes = 16;

function sealValue(
  secretEncryptionKey: string,
  scope: AccessScope,
  id: string,
  value: string
) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv(
    "aes-256-gcm",
    sealKey(secretEncryptionKey),
    iv,
    {
      authTagLength: tagBytes,
    }
  );
  cipher.setAAD(sealAad(scope, id));
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${sealPrefix}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

function openValue(
  secretEncryptionKey: string,
  scope: AccessScope,
  id: string,
  value: string
) {
  if (!value.startsWith(sealPrefix)) return undefined;
  const bytes = Buffer.from(value.slice(sealPrefix.length), "base64url");
  if (bytes.length <= ivBytes + tagBytes) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      sealKey(secretEncryptionKey),
      bytes.subarray(0, ivBytes),
      { authTagLength: tagBytes }
    );
    decipher.setAAD(sealAad(scope, id));
    decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
    return Buffer.concat([
      decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

function sealKey(secretEncryptionKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secretEncryptionKey, "base64"),
      "",
      "assist-connector-v1",
      32
    )
  );
}

function sealAad(scope: AccessScope, id: string) {
  return Buffer.from(`${scope.workspaceId}\u0000${namespace}\u0000${id}`);
}
