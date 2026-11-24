CREATE TABLE "site_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"workspace_id" text NOT NULL,
	"site_user" text NOT NULL,
	"session_id" text NOT NULL,
	"topic" text,
	"title" text,
	"teemiq_token" text,
	"teemiq_token_expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_chats_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "site_chats_teemiq_token_check" CHECK (("site_chats"."teemiq_token" IS NULL) = ("site_chats"."teemiq_token_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "site_chats" ADD CONSTRAINT "site_chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_chats_site_user_idx" ON "site_chats" USING btree ("site","workspace_id","site_user","created_at" DESC NULLS LAST);