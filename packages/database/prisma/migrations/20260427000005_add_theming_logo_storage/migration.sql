-- Logo uploader: el blob vive en el StorageService y la fila guarda key + MIME.
-- `logo_url` se mantiene para compat (URL externa pegada manualmente).
ALTER TABLE "mod_theming_tenant_theme"
  ADD COLUMN "logo_storage_key" TEXT,
  ADD COLUMN "logo_mime_type" TEXT;
