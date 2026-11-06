CREATE TYPE "public"."archive_origin" AS ENUM('portal', 'legacy_unreleased');--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "origin" "archive_origin" DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "linked_user_id" text;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "release_artist_id" integer;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "release_playlist_ids" integer[];--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "restore_path" text;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_linked_user_id_user_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_release_artist_id_artists_id_fk" FOREIGN KEY ("release_artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_linked_user_idx" ON "archive" USING btree ("linked_user_id");