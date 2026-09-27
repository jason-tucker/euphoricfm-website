ALTER TABLE "requests" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "deny_reason" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "pending_artist_id" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_pending_artist_id_artists_id_fk" FOREIGN KEY ("pending_artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;