# ADR-003 — Auth provider: Better-Auth vs Auth.js v5

- **Estado**: Proposed
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa
- **Bloqueante de**: FR-CORE-02 (IAM con MFA obligatorio) y Fase 1.A

## Contexto

LearnShip necesita autenticación con estos requisitos:

- Email + contraseña (argon2id preferido).
- MFA TOTP obligatorio para `super_admin` y `tenant_admin`.
- Providers OIDC pluggables (preparado para futuros SSO Google, Azure AD, etc. en Fase 2).
- API keys programáticas para integraciones.
- Multi-tenancy nativo: un usuario pertenece a exactamente un tenant.
- Sesiones con revocación.

Dos candidatos principales:

1. **Better-Auth**: librería joven (v1.x), API limpia, soporte multi-tenancy y MFA nativos.
2. **Auth.js v5 (NextAuth)**: ecosistema maduro, integración natural con Next.js, adoptado masivamente.

## Decisión

**Pendiente**. Recomendación actual: **Better-Auth**, sujeto a POC de 1 día.

Criterios que el POC debe validar:

- Soporte de API keys programáticas (no solo sesiones de usuario).
- MFA TOTP out-of-the-box con códigos de recuperación.
- Compatibilidad con Prisma 5.
- Integración con NestJS backend (no solo Next.js).
- Custom claims en el JWT/sesión para llevar `tenant_id` del request.

## Consecuencias posibles según decisión final

Si se elige **Better-Auth**:

- API más limpia para el caso multi-tenant.
- Menor madurez: mayor riesgo de regresiones / breaking changes.
- Menor volumen de issues resueltos.

Si se elige **Auth.js v5**:

- Ecosistema más grande y documentación extensa.
- Integración más estrecha con Next.js (puede ser bueno o malo según arquitectura).
- MFA y API keys requieren adaptadores adicionales.

## Plan

1. POC de 1 día con Better-Auth (antes del Sprint 1 de Fase 1.A).
2. Decidir y cerrar esta ADR con `Status: Accepted` o variante `Auth.js`.
3. Crear ADR-003b si la implementación revela una decisión de diseño no trivial (ej. dónde vive el JWT, cómo se renueva, etc.).

## Referencias

- `docs/CHECKLIST-ARRANQUE.md` §6.2
- [Better-Auth](https://www.better-auth.com/)
- [Auth.js v5](https://authjs.dev/)
