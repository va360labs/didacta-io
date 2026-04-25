# ADR-003 — Auth provider: Auth.js v5

- **Estado**: Accepted
- **Fecha**: 2026-04-25
- **Deciders**: Valentín Ayesa
- **Reemplaza**: versión Proposed del 2026-04-24 que dejaba abierto Better-Auth vs Auth.js v5

## Contexto

LearnShip necesita autenticación con estos requisitos:

- Email + contraseña con argon2id.
- MFA TOTP obligatorio para `super_admin` y `tenant_admin`.
- Providers OIDC pluggables (preparado para SSO Google, Azure AD, etc. en Fase 2).
- API keys programáticas para integraciones.
- Multi-tenancy nativo: un usuario pertenece a exactamente un tenant.
- Sesiones con revocación.

Dos candidatos principales: **Better-Auth** (lib joven, API limpia) y **Auth.js v5** (ecosistema maduro).

## Decisión

**Auth.js v5** (anteriormente NextAuth.js).

La decisión se tomó sin POC, priorizando:

- **Madurez y bajo riesgo de regresiones**: Auth.js v5 tiene años de adopción masiva, miles de issues resueltos y release estable.
- **Ecosistema**: documentación amplia, providers pre-construidos (Google, GitHub, Azure AD, etc.) listos para Fase 2.
- **Evitar dependencia de un proyecto joven**: Better-Auth está en su 1.x, con riesgo de breaking changes.
- **Integración natural con Next.js 15**: el frontend de LearnShip está sobre App Router; Auth.js v5 fue diseñado precisamente para ese flujo.
- **Backend-friendly**: con `@auth/core` se puede usar fuera de Next.js (NestJS API).

## Implementación planificada

### Stack

- `next-auth@5.x` en `apps/web` (frontend, manejo de sesión).
- `@auth/core` en `apps/api` para validar tokens y exponer endpoints de auth.
- `@auth/prisma-adapter` con el schema actual.
- `argon2` para hashing de password (no bcrypt).
- `otplib` para MFA TOTP.

### MFA TOTP obligatorio

Auth.js v5 no incluye MFA out-of-the-box. Se implementa como **callback custom** en el flujo de signin:

1. Usuario logea con email + password.
2. Si `user.mfa_enabled = true`, sesión queda en estado `mfa_required`.
3. Endpoint dedicado `/api/v1/auth/mfa/verify` valida el código TOTP y eleva la sesión a `authenticated`.
4. Roles `super_admin` y `tenant_admin` tienen `mfa_enabled = true` por trigger Prisma o seed.

### API keys

Tabla `api_key` ya en schema (PR 4). Endpoint propio `/api/v1/auth/api-keys` para CRUD. Validación en cada request via guard de NestJS que mira header `Authorization: ApiKey <token>`.

### Custom claims con tenant_id

JWT de sesión incluye `tenant_id` mediante `callbacks.jwt` y `callbacks.session` de Auth.js. El middleware de NestJS extrae el `tenant_id` del token y lo aplica a `withTenantContext`.

## Consecuencias

Positivas:

- **Time-to-market**: cero POC, librerías listas para integrar.
- **Sin lock-in fuerte**: si un día se quiere migrar a OIDC genérico (Auth0, Clerk, etc.), las interfaces son standard.
- **Tipos generados** mediante `next-auth/jwt` y `Session`.

Negativas / riesgos:

- **MFA es código nuestro**: Auth.js no lo provee de fábrica. Coste estimado: ~1-2 días de desarrollo + tests.
- **Auth.js es opinionated hacia Next.js**: usar `@auth/core` en NestJS requiere wrapper. Pequeño coste de integración.
- **Política de breaking changes**: Auth.js v5 ya está en stable, pero entre v4 → v5 hubo migraciones grandes. Asumimos riesgo bajo de v5 → v6 antes de Fase 2.

## Alternativas consideradas y descartadas

- **Better-Auth**: descartada por ser proyecto joven (riesgo de breaking changes y soporte).
- **Auth casero (jsonwebtoken + argon2)**: descartado por reinventar la rueda y aumentar superficie de bugs de seguridad.
- **Auth0 / Clerk / Supabase Auth (SaaS externos)**: descartados por dependencia de proveedor externo, costes recurrentes y residencia de datos fuera de UE en algunos casos.

## Referencias

- [Auth.js v5 docs](https://authjs.dev/)
- [@auth/core en backends no-Next](https://authjs.dev/guides/integrating-third-party-libraries)
- `packages/database/prisma/schema.prisma` (modelos `User`, `Session`, `ApiKey`)
- ADR-002 (RLS — el `tenant_id` en JWT habilita el aislamiento)
