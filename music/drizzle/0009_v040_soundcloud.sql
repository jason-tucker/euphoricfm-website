ALTER TABLE "items" ADD COLUMN "fetch_request_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "fetch_stage" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "fetch_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "fetch_license" text;--> statement-breakpoint
CREATE UNIQUE INDEX "items_fetch_req_uq" ON "items" USING btree ("fetch_request_id");--> statement-breakpoint
CREATE INDEX "items_owner_source_idx" ON "items" USING btree ("owner_user_id","source","created_at");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_fetch_stage" CHECK ("items"."fetch_stage" IS NULL OR "items"."fetch_stage" IN ('queued', 'fetching', 'converting'));