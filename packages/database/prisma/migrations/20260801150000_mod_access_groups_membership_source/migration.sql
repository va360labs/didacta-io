-- F6 (mod.access-groups formalizado): nuevo origen de membresía de grupo
-- `MEMBERSHIP` — lo concede/retira el bridge de la membresía de pago
-- (mod.subscriptions). La columna `source` es VarChar (sin enum), así que no
-- hay cambio de schema: esta migración es SOLO el backfill de datos.
--
-- Backfill CONSERVADOR (decisión F6): convertir a MEMBERSHIP únicamente las
-- membresías donde hay certeza de que las concedió la membresía de pago:
--   - membresía de grupo ACTIVE con source MANUAL (el default que grababa el
--     bridge hasta ahora; las TIER no se tocan),
--   - en EL grupo configurado como entitlement de la membresía del tenant
--     (mod_subscriptions_membership_config.access_group_id),
--   - de un usuario con una suscripción de MEMBRESÍA viva (plan_id no nulo,
--     status con acceso: ACTIVE, TRIALING o PAST_DUE — la gracia conserva el
--     acceso y su impago posterior debe poder revocarlo).
--
-- Lo que no cumple la heurística se queda MANUAL a propósito: mejor que un
-- impago futuro NO retire un acceso dudoso (el admin lo ve en el panel) a que
-- retire uno que en realidad concedió un admin a mano.
UPDATE mod_access_groups_group_member m
SET source = 'MEMBERSHIP'
FROM mod_subscriptions_membership_config c
WHERE m.tenant_id = c.tenant_id
  AND m.group_id = c.access_group_id
  AND m.status = 'ACTIVE'
  AND m.source = 'MANUAL'
  AND EXISTS (
    SELECT 1
    FROM mod_subscriptions_subscription s
    WHERE s.tenant_id = m.tenant_id
      AND s.user_id = m.user_id
      AND s.plan_id IS NOT NULL
      AND s.status IN ('ACTIVE', 'TRIALING', 'PAST_DUE')
  );
