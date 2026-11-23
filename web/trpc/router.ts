import Kernel, { NotFoundError } from "@onkernel/sdk";
import { z } from "zod";
import { listBrowserTraces } from "@db/services/browser-traces";
import { saveChat } from "@db/services/chats";
import { replaceUserProfile } from "@db/services/user-profile";
import {
  deleteVaultItem,
  readVaultItem,
  saveVaultItem,
} from "@db/services/vault";
import { kernelProfileNameForLogin } from "@shared/browser/kernel-profile";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { saveChatSchema } from "@shared/chat/schema";
import { userProfileSchema } from "@shared/user-profile/schema";
import {
  vaultCreateItemSchema,
  vaultImportItemsSchema,
} from "@shared/vault/schema";
import { createTRPCRouter, protectedProcedure } from "./init";

// The web layer may not import agent code, so it keeps its own Kernel client,
// as the browser handoff route does.
const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY });

export const appRouter = createTRPCRouter({
  chats: {
    save: protectedProcedure
      .input(saveChatSchema)
      .mutation(({ ctx, input }) => saveChat(ctx.scope, input)),
  },
  userProfile: {
    update: protectedProcedure
      .input(userProfileSchema)
      .output(userProfileSchema)
      .mutation(({ ctx, input }) => replaceUserProfile(ctx.scope, input)),
  },
  traces: {
    list: protectedProcedure
      .input(z.object({ cursor: z.string().nullish() }))
      .query(({ ctx, input }) =>
        listBrowserTraces(ctx.scope, input.cursor ?? undefined)
      ),
  },
  vault: {
    create: protectedProcedure
      .input(vaultCreateItemSchema)
      .mutation(({ ctx, input }) => saveVaultItem(ctx.scope, input)),
    import: protectedProcedure
      .input(vaultImportItemsSchema)
      .mutation(async ({ ctx, input }) => {
        /* oxlint-disable eslint/no-await-in-loop -- Import preserves source order and avoids concurrent writes to the same vault scope. */
        for (const item of input) await saveVaultItem(ctx.scope, item);
        /* oxlint-enable eslint/no-await-in-loop */
      }),
    remove: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const item = await readVaultItem(ctx.scope, input.id);
        const removed = await deleteVaultItem(ctx.scope, input.id);
        if (removed && item?.kind === "login") {
          await deleteLoginProfile(ctx.scope, input.id);
        }
        return removed;
      }),
  },
});

export type AppRouter = typeof appRouter;

// A site task pinned to a login kept that login's sign-in in a Kernel profile
// of its own, which would outlive the login. A Kernel failure never fails the
// removal: it leaves that profile behind and is logged by error name only.
async function deleteLoginProfile(scope: AccessScope, loginId: string) {
  try {
    await kernel.profiles.delete(
      kernelProfileNameForLogin(scope.workspaceId, loginId),
      { signal: AbortSignal.timeout(10_000) }
    );
  } catch (error) {
    if (error instanceof NotFoundError) return;
    console.warn("[vault] login browser profile could not be deleted", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
