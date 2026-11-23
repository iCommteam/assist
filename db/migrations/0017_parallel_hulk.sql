CREATE TABLE "task_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site" text NOT NULL,
	"workspace_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone DEFAULT now() + interval '7 days' NOT NULL,
	CONSTRAINT "task_files_media_type_check" CHECK ("task_files"."media_type" = 'application/pdf'),
	CONSTRAINT "task_files_byte_size_check" CHECK ("task_files"."byte_size" BETWEEN 1 AND 20971520 AND octet_length("task_files"."content") = "task_files"."byte_size"),
	CONSTRAINT "task_files_sha256_check" CHECK ("task_files"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "site_tasks" ADD COLUMN "login_id" text;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_files" ADD CONSTRAINT "task_files_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."site_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_files_task_idx" ON "task_files" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_files_expires_idx" ON "task_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "site_tasks_site_login_idx" ON "site_tasks" USING btree ("site","login_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vault_items_workspace_site_idx" ON "vault_items" USING btree ("workspace_id","site","created_at" DESC NULLS LAST);