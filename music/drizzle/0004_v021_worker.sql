ALTER TYPE "public"."archive_status" ADD VALUE 'archiving' BEFORE 'archived';--> statement-breakpoint
ALTER TYPE "public"."archive_status" ADD VALUE 'restoring' BEFORE 'restored';--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "upload_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_media_open_uq" ON "archive" USING btree ("media_id") WHERE "archive"."status" NOT IN ('restored', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_runs_target_path_active_uq" ON "ingest_runs" USING btree ("target_path") WHERE "ingest_runs"."target_path" IS NOT NULL AND "ingest_runs"."stage" NOT IN ('live', 'failed');