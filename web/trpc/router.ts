import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  emailOfUser,
  enrolledTeamMemberId,
  isAdminMember,
} from "@db/services/auth/allowlist";
import { listBrowserTraces } from "@db/services/browser-traces";
import { saveChat } from "@db/services/chats";
import { replaceUserProfile } from "@db/services/user-profile";
import {
  deleteVaultItem,
  readVaultItem,
  saveVaultItem,
} from "@db/services/vault";
import { saveChatSchema } from "@shared/chat/schema";
import { userProfileSchema } from "@shared/user-profile/schema";
import {
  vaultCreateItemSchema,
  vaultImportItemsSchema,
} from "@shared/vault/schema";
import {
  lockWhatsapp,
  unlockWhatsapp,
  whatsappEveryone,
} from "@db/services/whatsapp";
import {
  cancelWhatsappLinkCode,
  createWhatsappLinkCode,
  deleteWhatsappLink,
  whatsappLinkById,
  whatsappLinkCodeLive,
  whatsappLinkOf,
} from "@db/services/whatsapp-links";
import { postWhatsappLoopback } from "@shared/environment/loopback";
import { whatsappChannelConfigured } from "@shared/environment/whatsapp";
import type { AccessScope } from "@shared/identity/access-scope";
import { deleteLoginProfile } from "@web/browser/login-profile";
import { createTRPCRouter, protectedProcedure } from "./init";

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
  // WhatsApp's full access, off and back on. A member locks
  // and unlocks their own; an administrator locks everyone, and only an
  // administrator lifts that. A lock also ends the full chats it covers.
  // A member connects their own number with a link code, and disconnects it
  // here; an administrator can disconnect anyone's linked number, never one
  // ASSIST_WHATSAPP_NUMBERS sets.
  whatsapp: {
    linkCode: protectedProcedure.mutation(async ({ ctx }) => {
      const userId = betterAuthUserId(ctx.scope);
      await requireWhatsappMember(userId);
      const { code, expiresAt } = await createWhatsappLinkCode(userId);
      return { code, expiresAt: expiresAt.toISOString() };
    }),
    cancelLinkCode: protectedProcedure.mutation(async ({ ctx }) => {
      await cancelWhatsappLinkCode(betterAuthUserId(ctx.scope));
    }),
    linkStatus: protectedProcedure.query(async ({ ctx }) => {
      const userId = betterAuthUserId(ctx.scope);
      const [codeLive, link] = await Promise.all([
        whatsappLinkCodeLive(userId),
        whatsappLinkOf(userId),
      ]);
      return { codeLive, linkedId: link?.id ?? null };
    }),
    disconnect: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const userId = betterAuthUserId(ctx.scope);
        const link = await whatsappLinkById(input.id);
        // Someone else's link reads as no link, unless the caller is an
        // administrator.
        if (
          !link ||
          (link.userId !== userId && !(await isAdminMember(userId)))
        ) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        const removed = await deleteWhatsappLink(link.id, link.userId);
        if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
        await endWhatsappChats(`better-auth:${link.userId}`, removed.phone);
      }),
    lock: protectedProcedure.mutation(async ({ ctx }) => {
      await lockWhatsapp(betterAuthUserId(ctx.scope), "web");
      await endWhatsappChats(ctx.scope.userId);
    }),
    lockEveryone: protectedProcedure.mutation(async ({ ctx }) => {
      await requireAdmin(ctx.scope);
      await lockWhatsapp(whatsappEveryone, "admin");
      await endWhatsappChats(whatsappEveryone);
    }),
    unlock: protectedProcedure.mutation(async ({ ctx }) => {
      await unlockWhatsapp(betterAuthUserId(ctx.scope));
    }),
    unlockEveryone: protectedProcedure.mutation(async ({ ctx }) => {
      await requireAdmin(ctx.scope);
      await unlockWhatsapp(whatsappEveryone);
    }),
  },
});

export type AppRouter = typeof appRouter;

function betterAuthUserId(scope: AccessScope) {
  return scope.userId.slice("better-auth:".length);
}

async function requireAdmin(scope: AccessScope) {
  if (!(await isAdminMember(betterAuthUserId(scope)))) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

// A link code only for a member who may use WhatsApp, while the channel is
// open.
async function requireWhatsappMember(userId: string) {
  const email = whatsappChannelConfigured()
    ? await emailOfUser(userId)
    : undefined;
  if (email === undefined || (await enrolledTeamMemberId(email)) !== userId) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

// The WhatsApp channel ends the chats over loopback. The lock, or the
// disconnect, already holds when this fails: every turn of those chats is
// then cancelled by the access hooks at its next step, and the member's next
// message ends the chat.
async function endWhatsappChats(member: string, phone?: string) {
  try {
    const response = await postWhatsappLoopback(
      "/internal/whatsapp/end",
      phone === undefined ? { member } : { member, phone }
    );
    if (response.status !== 204) {
      console.warn("[whatsapp] the chats were not ended", {
        status: response.status,
      });
    }
  } catch (error) {
    console.warn("[whatsapp] the chats were not ended", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
