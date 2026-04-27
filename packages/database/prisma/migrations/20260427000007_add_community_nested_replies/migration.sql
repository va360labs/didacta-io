-- mod.community v0.2: nested replies (1 nivel).
ALTER TABLE "mod_community_comment"
  ADD COLUMN "parent_comment_id" UUID;

ALTER TABLE "mod_community_comment"
  ADD CONSTRAINT "mod_community_comment_parent_fkey"
  FOREIGN KEY ("parent_comment_id") REFERENCES "mod_community_comment"("id") ON DELETE CASCADE;

CREATE INDEX "mod_community_comment_parent_idx" ON "mod_community_comment"("parent_comment_id");
