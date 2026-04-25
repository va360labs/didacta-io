-- CreateTable
CREATE TABLE "mod_community_post" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "course_id" UUID,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "author_display_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "mod_community_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_community_post_tenant_id_course_id_created_at_idx" ON "mod_community_post"("tenant_id", "course_id", "created_at");

-- CreateIndex
CREATE INDEX "mod_community_post_tenant_id_author_id_idx" ON "mod_community_post"("tenant_id", "author_id");

-- CreateTable
CREATE TABLE "mod_community_comment" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "post_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "author_display_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "mod_community_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mod_community_comment_tenant_id_post_id_created_at_idx" ON "mod_community_comment"("tenant_id", "post_id", "created_at");

-- CreateTable
CREATE TABLE "mod_community_reaction" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "post_id" UUID,
  "comment_id" UUID,
  "author_id" UUID NOT NULL,
  "emoji" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mod_community_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_reaction_author_id_post_id_emoji_key" ON "mod_community_reaction"("author_id", "post_id", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "mod_community_reaction_author_id_comment_id_emoji_key" ON "mod_community_reaction"("author_id", "comment_id", "emoji");

-- CreateIndex
CREATE INDEX "mod_community_reaction_tenant_id_post_id_idx" ON "mod_community_reaction"("tenant_id", "post_id");

-- CreateIndex
CREATE INDEX "mod_community_reaction_tenant_id_comment_id_idx" ON "mod_community_reaction"("tenant_id", "comment_id");

-- AddForeignKey
ALTER TABLE "mod_community_comment"
  ADD CONSTRAINT "mod_community_comment_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "mod_community_post"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_reaction"
  ADD CONSTRAINT "mod_community_reaction_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "mod_community_post"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mod_community_reaction"
  ADD CONSTRAINT "mod_community_reaction_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "mod_community_comment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
