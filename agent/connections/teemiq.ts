import {
  ConnectionAuthorizationFailedError,
  defineDynamic,
  defineMcpClientConnection,
} from "eve/connections";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { siteChatOfSession } from "@agent/lib/site-principal";
import { readSiteChatToken } from "@db/services/site-chats";
import { env } from "@shared/environment";

// TEEMIQ's finance tools, as the person a site chat belongs to. TEEMIQ mints
// a short-lived token for each chat and sends it with every message; the
// chat's row keeps it until the turn ends. The connection exists only in a
// site chat, only while that chat holds a live token, and only when
// TEEMIQ_FINANCE_MCP_URL is set, so a turn without a token has no finance
// tools at all and nothing ever asks anyone to sign in.
const financeTools = [
  "finance_find_transactions",
  "finance_get_transaction",
  "finance_missing_invoices",
  "finance_find_documents",
  "finance_get_document",
  "finance_suppliers",
  "finance_site_accounts",
  "finance_site_look",
  "finance_fetch_invoice",
  "finance_fetch_status",
  "finance_propose_pairing",
  "finance_propose_invoice_way",
];

export default defineDynamic(async (ctx) => {
  const url = env.TEEMIQ_FINANCE_MCP_URL;
  const { initiator } = ctx.session.auth;
  const chat = siteChatOfSession(initiator);
  if (!url || !chat || !initiator) return null;
  const scope = scopeFromPrincipal(initiator);
  const sessionId = ctx.session.id;
  // The token is read again, never memoized: memos are stored with the
  // session, and the token must live in the chat's row alone.
  const readToken = () => readSiteChatToken(scope, chat.chatId, sessionId);
  if (!(await readToken())) return null;
  return defineMcpClientConnection({
    auth: {
      // Each chat's token is its own: the cache is keyed by the chat, not by
      // the owner every site chat acts as.
      async getToken() {
        const token = await readToken();
        if (!token) {
          throw new ConnectionAuthorizationFailedError("teemiq", {
            reason: "token_expired",
            retryable: false,
          });
        }
        return token;
      },
      principalType: "user",
    },
    description:
      "The company's Accounting in TEEMIQ, as the person in this chat: transactions, documents, suppliers, saved supplier-site accounts, looks and fetches on those accounts, and pairing proposals.",
    instanceKey: chat.chatId,
    tools: { allow: financeTools },
    url,
  });
});
