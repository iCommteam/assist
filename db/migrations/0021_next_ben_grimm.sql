CREATE TABLE "whatsapp_browser_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_chat_fetches" (
	"chat_id" uuid NOT NULL,
	"fetch_id" text NOT NULL,
	"recorded_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"status" text,
	"status_at" timestamp (3) with time zone,
	"seen_at" timestamp (3) with time zone,
	CONSTRAINT "whatsapp_chat_fetches_chat_id_fetch_id_pk" PRIMARY KEY("chat_id","fetch_id"),
	CONSTRAINT "whatsapp_chat_fetches_status_check" CHECK (("whatsapp_chat_fetches"."status" IS NULL OR "whatsapp_chat_fetches"."status" IN ('done', 'failed')) AND ("whatsapp_chat_fetches"."status" IS NULL) = ("whatsapp_chat_fetches"."status_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"last_sid" text,
	"last_sid_at" timestamp (3) with time zone,
	"announced_at" timestamp (3) with time zone,
	"teemiq_token" text,
	"teemiq_token_expires_at" timestamp (3) with time zone,
	"teemiq_user" text,
	"vouch_refusal" text,
	"vouch_refused_sid" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	CONSTRAINT "whatsapp_chats_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "whatsapp_chats_teemiq_token_check" CHECK (("whatsapp_chats"."teemiq_token" IS NULL) = ("whatsapp_chats"."teemiq_token_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_held_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "whatsapp_held_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone" text NOT NULL,
	"user_id" text NOT NULL,
	"level" text NOT NULL,
	"body" text,
	"media_url" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_held_replies_level_check" CHECK ("whatsapp_held_replies"."level" IN ('full', 'narrow')),
	CONSTRAINT "whatsapp_held_replies_content_check" CHECK (("whatsapp_held_replies"."body" IS NULL) <> ("whatsapp_held_replies"."media_url" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_locks" (
	"member" text PRIMARY KEY NOT NULL,
	"locked_by" text NOT NULL,
	"locked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_locks_locked_by_check" CHECK ("whatsapp_locks"."locked_by" IN ('admin', 'web', 'whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"sid" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"admitted" boolean DEFAULT false NOT NULL,
	"counted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_chat_fetches" ADD CONSTRAINT "whatsapp_chat_fetches_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."whatsapp_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_chats" ADD CONSTRAINT "whatsapp_chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_browser_tasks_user_idx" ON "whatsapp_browser_tasks" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_chats_member_idx" ON "whatsapp_chats" USING btree ("user_id","phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_held_replies_member_idx" ON "whatsapp_held_replies" USING btree ("user_id","phone","id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_phone_idx" ON "whatsapp_messages" USING btree ("phone","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_messages_received_idx" ON "whatsapp_messages" USING btree ("received_at");