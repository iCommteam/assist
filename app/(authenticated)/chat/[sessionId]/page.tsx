import { notFound } from "next/navigation";
import { ChatSession } from "./_components/chat-session";
import { readChat } from "@db/services/chats";
import { isAnySiteChatSession } from "@db/services/site-chats";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function ChatSessionPage({
  params,
}: PageProps<"/chat/[sessionId]">) {
  const { sessionId } = await params;
  const scope = await requireRequestScope();
  // A site chat is its person's alone; the owner's sign-in never opens it.
  if (await isAnySiteChatSession(sessionId)) notFound();
  const chat = await readChat(scope, sessionId);
  return (
    <ChatSession
      initialUsage={chat?.usage}
      key={sessionId}
      sessionId={sessionId}
    />
  );
}
