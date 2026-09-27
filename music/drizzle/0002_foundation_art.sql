-- Foundation (feat/music-portal-core): album-art uploads + library_cache.art_url.
-- art_url uses IF NOT EXISTS because P3 adds the same column; apply this
-- migration BEFORE the P3/P4 0002 migrations (renumber those when merging).
CREATE TYPE "public"."art_status" AS ENUM('processing', 'ready', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "art_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"status" "art_status" DEFAULT 'processing' NOT NULL,
	"reason" text,
	"raw_path" text,
	"raw_size" integer,
	"jpeg_path" text,
	"jpeg_sha256" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_cache" ADD COLUMN IF NOT EXISTS "art_url" text;--> statement-breakpoint
ALTER TABLE "art_uploads" ADD CONSTRAINT "art_uploads_owner_user_id_fk" FOREIGN KEY ("owner") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "art_uploads_owner_idx" ON "art_uploads" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "art_uploads_status_idx" ON "art_uploads" USING btree ("status","created_at");