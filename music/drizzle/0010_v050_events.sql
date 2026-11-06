CREATE TABLE "event_announcements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"source" text NOT NULL,
	"media_id" integer,
	"audio_id" bigint,
	"mode" text NOT NULL,
	"at" timestamp with time zone,
	"every_min" integer,
	"from_at" timestamp with time zone,
	"until_at" timestamp with time zone,
	CONSTRAINT "event_announcements_source" CHECK (("event_announcements"."source" = 'stinger' AND "event_announcements"."media_id" IS NOT NULL AND "event_announcements"."audio_id" IS NULL) OR ("event_announcements"."source" = 'upload' AND "event_announcements"."audio_id" IS NOT NULL AND "event_announcements"."media_id" IS NULL)),
	CONSTRAINT "event_announcements_mode" CHECK (("event_announcements"."mode" = 'at' AND "event_announcements"."at" IS NOT NULL AND "event_announcements"."every_min" IS NULL) OR ("event_announcements"."mode" = 'every' AND "event_announcements"."every_min" IN (15, 20, 30, 60) AND "event_announcements"."from_at" IS NOT NULL AND "event_announcements"."until_at" > "event_announcements"."from_at"))
);
--> statement-breakpoint
CREATE TABLE "event_audio" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_discord_id" text NOT NULL,
	"upload_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"artist" text,
	"duration_s" integer,
	"status" text NOT NULL,
	"probe_sha256" text,
	"transcode_kbps" integer,
	"input_format" text,
	"media_id" integer,
	"unique_id" text,
	"path" text,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_audio_kind" CHECK ("event_audio"."kind" IN ('song', 'announcement')),
	CONSTRAINT "event_audio_status" CHECK ("event_audio"."status" IN ('probing', 'ready', 'ingesting', 'live', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "event_builds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_builds_status" CHECK ("event_builds"."status" IN ('pending', 'applying', 'applied', 'failed', 'torn_down'))
);
--> statement-breakpoint
CREATE TABLE "event_jobs" (
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
CREATE TABLE "event_registry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"build_id" bigint NOT NULL,
	"role" text NOT NULL,
	"intent_name" text NOT NULL,
	"playlist_id" integer,
	"schedule_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "event_registry_role" CHECK ("event_registry"."role" IN ('main', 'pin', 'announce'))
);
--> statement-breakpoint
CREATE TABLE "event_stingers" (
	"media_id" integer PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"length_s" integer NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_tracks" (
	"event_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"source" text NOT NULL,
	"media_id" integer,
	"audio_id" bigint,
	"pin_at" timestamp with time zone,
	CONSTRAINT "event_tracks_event_id_position_pk" PRIMARY KEY("event_id","position"),
	CONSTRAINT "event_tracks_source" CHECK (("event_tracks"."source" = 'library' AND "event_tracks"."media_id" IS NOT NULL AND "event_tracks"."audio_id" IS NULL) OR ("event_tracks"."source" = 'upload' AND "event_tracks"."audio_id" IS NOT NULL AND "event_tracks"."media_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_discord_id" text NOT NULL,
	"title" text NOT NULL,
	"host_name" text,
	"description" text,
	"location" text,
	"event_type" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"entered_tz" text NOT NULL,
	"visibility" text NOT NULL,
	"status" text NOT NULL,
	"short_notice" boolean DEFAULT false NOT NULL,
	"playlist_order" text DEFAULT 'shuffle' NOT NULL,
	"ticket_id" integer,
	"ticket_number" integer,
	"ticket_url" text,
	"created_by_staff" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"deny_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_ends_after_starts" CHECK ("events"."ends_at" > "events"."starts_at"),
	CONSTRAINT "events_title_len" CHECK (char_length("events"."title") BETWEEN 1 AND 80),
	CONSTRAINT "events_host_name_len" CHECK ("events"."host_name" IS NULL OR char_length("events"."host_name") <= 80),
	CONSTRAINT "events_description_len" CHECK ("events"."description" IS NULL OR char_length("events"."description") <= 2000),
	CONSTRAINT "events_location_len" CHECK ("events"."location" IS NULL OR char_length("events"."location") <= 120),
	CONSTRAINT "events_status" CHECK ("events"."status" IN ('draft', 'pending', 'approved', 'built', 'live', 'ended', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed')),
	CONSTRAINT "events_visibility" CHECK ("events"."visibility" IN ('public', 'private')),
	CONSTRAINT "events_playlist_order" CHECK ("events"."playlist_order" IN ('shuffle', 'sequential')),
	CONSTRAINT "events_event_type" CHECK ("events"."event_type" IN ('grand_opening', 'club_night', 'private_party', 'car_meet', 'business', 'community', 'special', 'other'))
);
--> statement-breakpoint
ALTER TABLE "art_uploads" ADD COLUMN "site" text DEFAULT 'music' NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "site" text DEFAULT 'music' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_announcements" ADD CONSTRAINT "event_announcements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_announcements" ADD CONSTRAINT "event_announcements_audio_id_event_audio_id_fk" FOREIGN KEY ("audio_id") REFERENCES "public"."event_audio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_audio" ADD CONSTRAINT "event_audio_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_audio" ADD CONSTRAINT "event_audio_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_builds" ADD CONSTRAINT "event_builds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registry" ADD CONSTRAINT "event_registry_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registry" ADD CONSTRAINT "event_registry_build_id_event_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."event_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tracks" ADD CONSTRAINT "event_tracks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tracks" ADD CONSTRAINT "event_tracks_audio_id_event_audio_id_fk" FOREIGN KEY ("audio_id") REFERENCES "public"."event_audio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_announcements_event_idx" ON "event_announcements" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_announcements_audio_idx" ON "event_announcements" USING btree ("audio_id");--> statement-breakpoint
CREATE INDEX "event_audio_owner_status_idx" ON "event_audio" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "event_audio_status_idx" ON "event_audio" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "event_builds_event_idx" ON "event_builds" USING btree ("event_id","version");--> statement-breakpoint
CREATE INDEX "event_jobs_ready_idx" ON "event_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "event_jobs_dedupe_uq" ON "event_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "event_registry_event_idx" ON "event_registry" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_registry_playlist_uq" ON "event_registry" USING btree ("playlist_id") WHERE "event_registry"."playlist_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_tracks_audio_idx" ON "event_tracks" USING btree ("audio_id");--> statement-breakpoint
CREATE INDEX "events_status_starts_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_owner_status_idx" ON "events" USING btree ("owner_user_id","status");--> statement-breakpoint
ALTER TABLE "art_uploads" ADD CONSTRAINT "art_uploads_site" CHECK ("art_uploads"."site" IN ('music', 'events'));--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_site" CHECK ("uploads"."site" IN ('music', 'events'));