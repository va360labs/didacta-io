-- mod.community v0.2: menciones @usuario en posts y comments.
CREATE TABLE "mod_community_mention" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "post_id" UUID,
  "comment_id" UUID,
  "mentioned_user_id" UUID NOT NULL,
  "mentioned_handle" TEXT NOT NULL,
  "author_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mod_community_mention_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mod_community_mention_user_idx" ON "mod_community_mention"("tenant_id", "mentioned_user_id", "created_at" DESC);
CREATE INDEX "mod_community_mention_post_idx" ON "mod_community_mention"("post_id") WHERE "post_id" IS NOT NULL;
CREATE INDEX "mod_community_mention_comment_idx" ON "mod_community_mention"("comment_id") WHERE "comment_id" IS NOT NULL;
