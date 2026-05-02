/// Política global de MFA por rol — decidida por el operador del deploy.
///
/// **Default = NO obligatorio**. Históricamente FR-CORE-02 lo exigía a
/// admins, pero feedback de operadores no técnicos (alpha) muestra que el
/// redirect forzado a `/mfa/setup` en el primer login es un stopper de UX.
/// Volvemos a la postura "MFA es responsabilidad del usuario, accesible
/// desde su perfil de seguridad" y dejamos que el operador opt-IN si su
/// compliance lo requiere.
///
/// Activación opt-in:
///   `DIDACTA_REQUIRE_MFA_ADMIN=true` (o `1`, `yes`, `on` — case-insensitive).
/// Cualquier otro valor (incluido vacío y env no seteada) → no obligatorio.
///
/// La política tenant-wide (`feat:mfa.enforcement` capability EE) sigue
/// independiente — vive en `MfaPolicyService` y se gestiona desde
/// `/admin/seguridad`. Ese flujo sigue funcionando aunque este flag esté
/// off: si el tenant_admin lo activa, sus usuarios reciben el aviso
/// `mfaRequiredSoon` y eventualmente pasan por enforcement.

export function isAdminMfaEnforced(): boolean {
  const raw = (process.env['DIDACTA_REQUIRE_MFA_ADMIN'] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}
