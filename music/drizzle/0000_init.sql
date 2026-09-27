CREATE TYPE "public"."archive_status" AS ENUM('archived', 'restored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."artist_status" AS ENUM('active', 'pending', 'denied', 'archived');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('draft', 'submitted', 'completed', 'closed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."comment_source" AS ENUM('portal', 'ticket');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('song', 'new_artist');--> statement-breakpoint
CREATE TYPE "public"."item_source" AS ENUM('upload', 'soundcloud');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('probing', 'rejected', 'draft', 'pending', 'approved', 'denied', 'withdrawn', 'applying', 'verifying', 'live', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."role_permission" AS ENUM('review', 'manage');--> statement-breakpoint
CREATE TYPE "public"."request_kind" AS ENUM('edit', 'removal');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'approved', 'denied', 'withdrawn', 'applying', 'verifying', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'complete', 'attached', 'expired');--> statement-breakpoint
CREATE TYPE "public"."comment_visibility" AS ENUM('all', 'staff');--> statement-breakpoint
CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "archive" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_id" integer NOT NULL,
	"unique_id" text,
	"original_path" text NOT NULL,
	"archived_path" text NOT NULL,
	"snapshot_id" integer,
	"request_id" integer,
	"status" "archive_status" DEFAULT 'archived' NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"folder" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "artist_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_discord_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" "batch_status" DEFAULT 'draft' NOT NULL,
	"attested_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"ticket_id" integer,
	"ticket_number" integer,
	"ticket_web_url" text,
	"ticket_channel_url" text,
	"ticket_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer,
	"item_id" integer,
	"request_id" integer,
	"author_user_id" text,
	"author_discord_id" text,
	"author_name" text,
	"source" "comment_source" NOT NULL,
	"visibility" "comment_visibility" NOT NULL,
	"body" text NOT NULL,
	"delivery_id" text,
	"ticket_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_parent" CHECK (("comments"."batch_id" IS NOT NULL) <> ("comments"."request_id" IS NOT NULL)),
	CONSTRAINT "comments_staff_local" CHECK ("comments"."visibility" <> 'staff' OR ("comments"."source" = 'portal' AND "comments"."ticket_message_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "hook_deliveries" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"ticket_id" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" "item_kind" DEFAULT 'song' NOT NULL,
	"source" "item_source" DEFAULT 'upload' NOT NULL,
	"status" "item_status" NOT NULL,
	"upload_id" text,
	"probe_request_id" uuid,
	"probe_sha256" text,
	"probe_error" text,
	"approved_sha256" text,
	"final_sha256" text,
	"cover_file" text,
	"cover_sha256" text,
	"duration_s" integer,
	"bitrate" integer,
	"prefill" jsonb,
	"title" text,
	"artist" text,
	"album" text,
	"genre" text,
	"artist_id" integer,
	"new_artist_name" text,
	"playlist_ids" integer[],
	"target_path" text,
	"media_id" integer,
	"deny_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"live_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_cache" (
	"media_id" integer PRIMARY KEY NOT NULL,
	"unique_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text,
	"artist" text,
	"album" text,
	"genre" text,
	"playlist_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"length_s" integer,
	"mtime" integer,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_id" integer NOT NULL,
	"unique_id" text,
	"path" text NOT NULL,
	"title" text,
	"artist" text,
	"album" text,
	"genre" text,
	"playlist_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"reason" text NOT NULL,
	"item_id" integer,
	"request_id" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_cache" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"member" boolean NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"role_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" "request_kind" NOT NULL,
	"media_id" integer NOT NULL,
	"target_path" text NOT NULL,
	"proposed" jsonb,
	"reason" text,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"ticket_id" integer,
	"ticket_number" integer,
	"ticket_web_url" text,
	"ticket_channel_url" text,
	"ticket_status" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"permission" "role_permission" NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"length" integer NOT NULL,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp with time zone,
	"image" text,
	"discord_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_discord_id_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_snapshot_id_media_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."media_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_snapshots" ADD CONSTRAINT "media_snapshots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_snapshots" ADD CONSTRAINT "media_snapshots_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_media_idx" ON "archive" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_folder_uq" ON "artists" USING btree ("folder");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "batches_owner_idx" ON "batches" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_ticket_uq" ON "batches" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_delivery_uq" ON "comments" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "comments_batch_idx" ON "comments" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "comments_request_idx" ON "comments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "items_batch_idx" ON "items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "items_owner_idx" ON "items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "items_status_idx" ON "items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "items_upload_uq" ON "items" USING btree ("upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_probe_req_uq" ON "items" USING btree ("probe_request_id");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "library_cache_path_uq" ON "library_cache" USING btree ("path");--> statement-breakpoint
CREATE INDEX "media_snapshots_media_idx" ON "media_snapshots" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "requests_owner_idx" ON "requests" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_ticket_uq" ON "requests" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_role_perm" ON "role_bindings" USING btree ("role_id","permission");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "uploads_owner_status_idx" ON "uploads" USING btree ("owner_user_id","status");