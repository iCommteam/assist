CREATE TABLE "site_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site" text NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_tasks_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "site_tasks" ADD CONSTRAINT "site_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_tasks_site_idx" ON "site_tasks" USING btree ("site","created_at" DESC NULLS LAST);