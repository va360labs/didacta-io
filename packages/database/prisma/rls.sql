-- ============================================================================
-- Didacta — Row-Level Security + triggers de append-only
-- ----------------------------------------------------------------------------
-- Se aplica después de cada migración Prisma:
--   pnpm --filter @didacta/database db:rls:apply
--
-- Cada transacción debe setear `app.current_tenant_id` vía middleware:
--   SET LOCAL app.current_tenant_id = '<uuid del tenant>';
-- El middleware del backend lo ejecuta en cada request tras resolver el tenant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: obtener el tenant actual (null si no está seteado)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
DECLARE
  v_id text;
BEGIN
  v_id := current_setting('app.current_tenant_id', true);
  IF v_id IS NULL OR v_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_id::uuid;
END;
$$ LANGUAGE plpgsql STABLE;

-- ----------------------------------------------------------------------------
-- Política genérica por tenant_id
-- Aplica a todas las tablas con columna tenant_id
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t2
      ON t2.table_schema = c.table_schema AND t2.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND t2.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.table_schema, t.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.table_schema, t.table_name);

    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I.%I',
      t.table_schema, t.table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())',
      t.table_schema, t.table_name
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Audit log: append-only (bloquear UPDATE y DELETE)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es append-only: no se permiten UPDATE ni DELETE (intento: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_mutation();

-- ----------------------------------------------------------------------------
-- Libro mayor de mod.payouts: solo inserción (bloquear UPDATE y DELETE)
-- ----------------------------------------------------------------------------
-- Cada movimiento de dinero del creador es un asiento nuevo; una corrección es
-- OTRO asiento (ADJUSTMENT), nunca editar el anterior. Igual que `audit_log`:
-- el trigger va BEFORE y FOR EACH ROW, así que también corta al dueño de la
-- tabla y a `didacta_super` (el bypass de RLS no salta triggers).
CREATE OR REPLACE FUNCTION mod_payouts_ledger_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mod_payouts_ledger_entry es de solo inserción: no se permiten UPDATE ni DELETE (intento: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mod_payouts_ledger_no_update ON mod_payouts_ledger_entry;
DROP TRIGGER IF EXISTS mod_payouts_ledger_no_delete ON mod_payouts_ledger_entry;

CREATE TRIGGER mod_payouts_ledger_no_update
  BEFORE UPDATE ON mod_payouts_ledger_entry
  FOR EACH ROW
  EXECUTE FUNCTION mod_payouts_ledger_block_mutation();

CREATE TRIGGER mod_payouts_ledger_no_delete
  BEFORE DELETE ON mod_payouts_ledger_entry
  FOR EACH ROW
  EXECUTE FUNCTION mod_payouts_ledger_block_mutation();

-- ----------------------------------------------------------------------------
-- Facturas de mod.payouts: inmutables una vez emitidas (RD 1619/2012)
-- ----------------------------------------------------------------------------
-- Una factura emitida no se borra ni se cambia: una corrección es una
-- rectificativa nueva. Lo único que se puede tocar después es el estado del
-- envío por correo, el enlace a la rectificativa que la sustituye (una sola
-- vez) y el bloque cifrado cuando se rota la clave maestra (el texto en claro
-- no cambia: lo verifica `rotate-cipher-key.ts`). Las líneas son de solo
-- inserción. Igual que el libro: BEFORE + FOR EACH ROW, también para el dueño.
CREATE OR REPLACE FUNCTION mod_payouts_invoice_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mod_payouts_invoice: una factura emitida no se borra (se rectifica)';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.account_id, NEW.kind, NEW.series, NEW.number, NEW.full_number,
      NEW.slot, NEW.issue_date, NEW.period_start, NEW.period_end, NEW.currency, NEW.regime,
      NEW.vat_rate_bps, NEW.total, NEW.tax_base, NEW.vat_amount, NEW.issuer,
      NEW.recipient_legal_name, NEW.recipient_country, NEW.recipient_entity_type,
      NEW.recipient_complete, NEW.rectifies, NEW.rectification_reason, NEW.livemode,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.account_id, OLD.kind, OLD.series, OLD.number, OLD.full_number,
      OLD.slot, OLD.issue_date, OLD.period_start, OLD.period_end, OLD.currency, OLD.regime,
      OLD.vat_rate_bps, OLD.total, OLD.tax_base, OLD.vat_amount, OLD.issuer,
      OLD.recipient_legal_name, OLD.recipient_country, OLD.recipient_entity_type,
      OLD.recipient_complete, OLD.rectifies, OLD.rectification_reason, OLD.livemode,
      OLD.created_at) THEN
    RAISE EXCEPTION 'mod_payouts_invoice: una factura emitida es inmutable (se rectifica con otra)';
  END IF;
  IF OLD.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id THEN
    RAISE EXCEPTION 'mod_payouts_invoice: la factura ya está sustituida por una rectificativa';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mod_payouts_invoice_immutable ON mod_payouts_invoice;
CREATE TRIGGER mod_payouts_invoice_immutable
  BEFORE UPDATE OR DELETE ON mod_payouts_invoice
  FOR EACH ROW
  EXECUTE FUNCTION mod_payouts_invoice_block_mutation();

CREATE OR REPLACE FUNCTION mod_payouts_invoice_item_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mod_payouts_invoice_item es de solo inserción (intento: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mod_payouts_invoice_item_no_update ON mod_payouts_invoice_item;
DROP TRIGGER IF EXISTS mod_payouts_invoice_item_no_delete ON mod_payouts_invoice_item;
CREATE TRIGGER mod_payouts_invoice_item_no_update
  BEFORE UPDATE ON mod_payouts_invoice_item
  FOR EACH ROW
  EXECUTE FUNCTION mod_payouts_invoice_item_block_mutation();
CREATE TRIGGER mod_payouts_invoice_item_no_delete
  BEFORE DELETE ON mod_payouts_invoice_item
  FOR EACH ROW
  EXECUTE FUNCTION mod_payouts_invoice_item_block_mutation();

-- ----------------------------------------------------------------------------
-- Consentimientos de compra: la prueba no se reescribe
-- ----------------------------------------------------------------------------
-- Lo que el comprador aceptó (texto, versión, idioma, fecha, IP, qué compraba
-- y a quién) queda congelado al insertarse. Después solo se rellenan la sesión
-- de Stripe, la orden, el correo confirmado, el pago y el envío de la
-- confirmación. Borrar sí se puede (supresión de datos a petición del interesado).
CREATE OR REPLACE FUNCTION purchase_consent_block_rewrite() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.purchase_kind, NEW.item_ref, NEW.item_name,
      NEW.user_id, NEW.seller_name, NEW.payment_mode, NEW.version, NEW.locale, NEW.text,
      NEW.ip, NEW.user_agent, NEW.accepted_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.kind, OLD.purchase_kind, OLD.item_ref, OLD.item_name,
      OLD.user_id, OLD.seller_name, OLD.payment_mode, OLD.version, OLD.locale, OLD.text,
      OLD.ip, OLD.user_agent, OLD.accepted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'purchase_consent: la prueba del consentimiento no se puede reescribir';
  END IF;
  IF OLD.stripe_checkout_session_id IS NOT NULL
     AND NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id THEN
    RAISE EXCEPTION 'purchase_consent: la sesión de pago ya estaba asociada';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_consent_no_rewrite ON purchase_consent;
CREATE TRIGGER purchase_consent_no_rewrite
  BEFORE UPDATE ON purchase_consent
  FOR EACH ROW
  EXECUTE FUNCTION purchase_consent_block_rewrite();

-- ----------------------------------------------------------------------------
-- Rol de aplicación: exento de RLS solo para super_admin (migraciones, jobs globales)
-- ----------------------------------------------------------------------------
-- Los workers/superadmin usan este rol cuando necesitan saltarse RLS (seeders, cron jobs).
-- Jamás debe usarse en request path de usuarios finales.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'didacta_super') THEN
    CREATE ROLE didacta_super BYPASSRLS;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Índices únicos parciales (Prisma no expresa @@unique con WHERE)
-- Se aplican aquí porque Prisma no los expresa; el deploy los aplica con psql
-- justo después de `prisma migrate deploy` (el `db push` que decía este
-- comentario dejó de ser el camino hace versiones — ver infra/docker/entrypoint.sh).
-- Idempotentes (IF NOT EXISTS).
-- ----------------------------------------------------------------------------
-- Inscripción de miembros: telegram_id único por tenant cuando está presente.
-- Permite múltiples NULL (usuarios no creados por el flujo de Telegram).
-- DEPRECADO (D13): columnas de user en transición a mod_member_registration_profile;
-- este índice se retira en D13 F4 junto con las columnas.
CREATE UNIQUE INDEX IF NOT EXISTS user_tenant_telegram_id_key
  ON "user" ("tenant_id", "telegram_id")
  WHERE telegram_id IS NOT NULL;

-- Perfil de registro (mod.member-registration): mismo invariante sobre la
-- tabla nueva — telegram_id único por tenant cuando está presente.
CREATE UNIQUE INDEX IF NOT EXISTS mod_member_registration_profile_tenant_tg_key
  ON "mod_member_registration_profile" ("tenant_id", "telegram_id")
  WHERE telegram_id IS NOT NULL;
