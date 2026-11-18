-- CreateTable
CREATE TABLE "meeting_interviewers" (
    "meeting_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_interviewers_pkey" PRIMARY KEY ("meeting_id","user_id")
);

-- CreateIndex
CREATE INDEX "meeting_interviewers_user_meeting_idx" ON "meeting_interviewers"("user_id", "meeting_id");

-- AddForeignKey
ALTER TABLE "meeting_interviewers" ADD CONSTRAINT "meeting_interviewers_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_interviewers" ADD CONSTRAINT "meeting_interviewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
