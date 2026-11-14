CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(150) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_title_not_blank" CHECK (length(trim("meetings"."title")) > 0),
	CONSTRAINT "meetings_description_max" CHECK (length("meetings"."description") <= 5000),
	CONSTRAINT "meetings_status_valid" CHECK ("meetings"."status" in ('PENDING', 'CONFIRMED', 'CANCELLED')),
	CONSTRAINT "meetings_version_positive" CHECK ("meetings"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "meetings_due_date_id_idx" ON "meetings" USING btree ("due_date","id");