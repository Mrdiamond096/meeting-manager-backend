-- ADR-015: replace the single USER role with ADMIN / RECRUITER / INTERVIEWER.
-- Existing accounts keep today's rights (team-wide scheduling) as RECRUITER.
ALTER TABLE "users" DROP CONSTRAINT "users_role_valid";
UPDATE "users" SET "role" = 'RECRUITER' WHERE "role" = 'USER';
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'RECRUITER';
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_valid" CHECK ("role" in ('ADMIN', 'RECRUITER', 'INTERVIEWER'));
