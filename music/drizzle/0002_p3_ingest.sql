CREATE TYPE "public"."ingest_stage" AS ENUM('finalize', 'finalizing', 'ready', 'uploaded', 'playlists', 'verifying', 'recovering', 'live', 'failed');--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"item_id" integer PRIMARY KEY NOT NULL,
	"stage" "ingest_stage" DEFAULT 'finalize' NOT NULL,
	"finalize_request_id" uuid,
	"finalize_requested_at" timestamp with time zone,
	"final_file" text,
	"final_removed_at" timestamp with time zone,
	"playlist_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"target_path" text,
	"media_id" integer,
	"unique_id" text,
	"uploaded_at" timestamp with time zone,
	"verify_due_at" timestamp with time zone,
	"repairs" integer DEFAULT 0 NOT NULL,
	"recovery_polls" integer DEFAULT 0 NOT NULL,
	"recovery_started_at" timestamp with time zone,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "attest_version" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "custom_art_id" uuid;--> statement-breakpoint
-- The foundation branch adds this column too: idempotent on purpose.
ALTER TABLE "library_cache" ADD COLUMN IF NOT EXISTS "art_url" text;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_runs_uploaded_idx" ON "ingest_runs" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "ingest_runs_stage_idx" ON "ingest_runs" USING btree ("stage");