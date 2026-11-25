CREATE TABLE "whatsapp_link_codes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_link_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_link_failures" (
	"sid" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"failed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"phone" text NOT NULL,
	"message_sid" text NOT NULL,
	"linked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_links_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "whatsapp_links_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_link_codes" ADD CONSTRAINT "whatsapp_link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_links" ADD CONSTRAINT "whatsapp_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_link_failures_phone_idx" ON "whatsapp_link_failures" USING btree ("phone","failed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_link_failures_failed_idx" ON "whatsapp_link_failures" USING btree ("failed_at");