CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" varchar(100) NOT NULL,
	"role" varchar(16) DEFAULT 'USER' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_normalized" CHECK ("users"."email" = lower(trim("users"."email"))),
	CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('USER'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"code_hash" varchar(100) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenges_purpose_valid" CHECK ("otp_challenges"."purpose" in ('REGISTER', 'LOGIN', 'RESET')),
	CONSTRAINT "otp_challenges_attempts_range" CHECK ("otp_challenges"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"position" varchar(80) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_name_not_blank" CHECK (length(trim("candidates"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_body_length" CHECK (length(trim("feedback"."body")) between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "meeting_type" varchar(16);--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "provider" varchar(16);--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_user_purpose_idx" ON "otp_challenges" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "candidates_name_idx" ON "candidates" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "feedback_meeting_created_at_idx" ON "feedback" USING btree ("meeting_id","created_at");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_candidate_due_date_idx" ON "meetings" USING btree ("candidate_id","due_date","id");--> statement-breakpoint
CREATE INDEX "meetings_created_by_due_date_idx" ON "meetings" USING btree ("created_by","due_date","id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_end_after_start" CHECK ("meetings"."end_at" is null or "meetings"."end_at" > "meetings"."due_date");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_type_valid" CHECK ("meetings"."meeting_type" is null or "meetings"."meeting_type" in ('ONSITE', 'ONLINE'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_provider_valid" CHECK ("meetings"."provider" is null or "meetings"."provider" in ('ZOOM', 'GOOGLE_MEET', 'OTHER'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_provider_only_online" CHECK ("meetings"."provider" is null or "meetings"."meeting_type" = 'ONLINE');