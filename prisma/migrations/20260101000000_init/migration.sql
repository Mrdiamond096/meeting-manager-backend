-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'USER',
    "email_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "code_hash" VARCHAR(100) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "position" VARCHAR(80) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID,
    "title" VARCHAR(150) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "meeting_type" VARCHAR(16),
    "provider" VARCHAR(16),
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "meeting_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_unique" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "otp_challenges_user_purpose_idx" ON "otp_challenges"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "meetings_due_date_id_idx" ON "meetings"("due_date", "id");

-- CreateIndex
CREATE INDEX "meetings_candidate_due_date_idx" ON "meetings"("candidate_id", "due_date", "id");

-- CreateIndex
CREATE INDEX "meetings_created_by_due_date_idx" ON "meetings"("created_by", "due_date", "id");

-- CreateIndex
CREATE INDEX "feedback_meeting_created_at_idx" ON "feedback"("meeting_id", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Not expressible in schema.prisma: expression index and CHECK constraints.
CREATE INDEX "candidates_name_idx" ON "candidates" (lower("name"));

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(trim("email"))),
  ADD CONSTRAINT "users_role_valid" CHECK ("role" in ('USER'));

ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_purpose_valid" CHECK ("purpose" in ('REGISTER', 'LOGIN', 'RESET')),
  ADD CONSTRAINT "otp_challenges_attempts_range" CHECK ("attempts" between 0 and 5);

ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_name_not_blank" CHECK (length(trim("name")) > 0);

ALTER TABLE "meetings"
  ADD CONSTRAINT "meetings_title_not_blank" CHECK (length(trim("title")) > 0),
  ADD CONSTRAINT "meetings_description_max" CHECK (length("description") <= 5000),
  ADD CONSTRAINT "meetings_status_valid" CHECK ("status" in ('PENDING', 'CONFIRMED', 'CANCELLED')),
  ADD CONSTRAINT "meetings_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "meetings_end_after_start" CHECK ("end_at" is null or "end_at" > "due_date"),
  ADD CONSTRAINT "meetings_type_valid" CHECK ("meeting_type" is null or "meeting_type" in ('ONSITE', 'ONLINE')),
  ADD CONSTRAINT "meetings_provider_valid" CHECK ("provider" is null or "provider" in ('ZOOM', 'GOOGLE_MEET', 'OTHER')),
  ADD CONSTRAINT "meetings_provider_only_online" CHECK ("provider" is null or "meeting_type" = 'ONLINE');

ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_body_length" CHECK (length(trim("body")) between 1 and 5000);
