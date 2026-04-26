-- =============================================================================
-- mod.theming v0.1 — branding y personalización per-tenant.
-- Un único registro por tenant; defaults alineados a la guía visual Didacta.
-- =============================================================================

CREATE TABLE "mod_theming_tenant_theme" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "brand_hue" INTEGER NOT NULL DEFAULT 213,
    "brand_saturation" INTEGER NOT NULL DEFAULT 70,
    "display_font_family" TEXT NOT NULL DEFAULT 'Sora',
    "body_font_family" TEXT NOT NULL DEFAULT 'Inter',
    "custom_css" TEXT,
    "footer_html" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_theming_tenant_theme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mod_theming_tenant_theme_tenant_id_key"
    ON "mod_theming_tenant_theme"("tenant_id");

-- Validación de rangos a nivel DB (defensa en profundidad además del DTO).
ALTER TABLE "mod_theming_tenant_theme"
    ADD CONSTRAINT "mod_theming_tenant_theme_brand_hue_range"
    CHECK ("brand_hue" >= 0 AND "brand_hue" <= 360);

ALTER TABLE "mod_theming_tenant_theme"
    ADD CONSTRAINT "mod_theming_tenant_theme_brand_saturation_range"
    CHECK ("brand_saturation" >= 0 AND "brand_saturation" <= 100);
