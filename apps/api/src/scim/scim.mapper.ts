/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Mapper SCIM ↔ User interno (séptimo piloto License SDK).
 *
 * Convenciones de mapping (basadas en cómo lo emiten Okta, Azure AD y Auth0):
 *
 *   SCIM userName       → User.email
 *   SCIM emails[primary]→ User.email (fallback si no hay userName)
 *   SCIM name.givenName + name.familyName → User.name (concatenado)
 *   SCIM displayName    → User.name (fallback si no hay name)
 *   SCIM active=true    → User.status = 'ACTIVE' (o 'PENDING' al crear)
 *   SCIM active=false   → User.status = 'DEACTIVATED'
 *   SCIM locale         → User.locale
 *   SCIM externalId     → ignorado (queda como TODO, requiere migración Prisma)
 *
 * Nota:
 *   - El piloto NO añade migración Prisma. Por eso `externalId` no se persiste
 *     en este iteración; lo aceptamos en el payload de POST/PATCH y lo
 *     ignoramos al persistir, pero lo devolvemos sintetizado al cliente
 *     (id interno = externalId al ojo del IdP) — opción aceptable porque la
 *     mayoría de IdPs aceptan `id == externalId`.
 *   - "active=false" mapea a DEACTIVATED, NO a borrado. Cumple la regla del
 *     spec (RFC 7643 §4.1.1: "active SHOULD signify whether the User can
 *     authenticate").
 */

import type { ScimMeta, ScimUser } from './scim.types';
import { SCIM_SCHEMAS } from './scim.types';
import type { ScimCreateUserDto } from './scim.dto';

/**
 * Subset de los campos User que el mapper necesita. Lo definimos a mano (en vez
 * de `Pick<PrismaUser, ...>`) porque `@didacta/database` no exporta el tipo
 * `User` y el mapper no necesita acoplarse al cliente Prisma — sólo a los
 * campos que lee.
 */
export interface ScimMappedUser {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Construye la URL relativa SCIM del recurso. La hacemos relativa a propósito
 * — los IdPs aceptan tanto absolutas como relativas, y relativas evitan
 * acoplarnos al hostname (que cambia per tenant con custom-domains).
 */
export function userLocation(userId: string): string {
  return `/scim/v2/Users/${userId}`;
}

/**
 * Convierte un User interno (Prisma) a un recurso SCIM 2.0.
 *
 * Determinismo: dada la misma fila User, la salida es estable. Esto importa
 * para los IdPs que comparan respuestas vs caché propio.
 */
export function userToScim(user: ScimMappedUser): ScimUser {
  const meta: ScimMeta = {
    resourceType: 'User',
    created: user.createdAt.toISOString(),
    lastModified: user.updatedAt.toISOString(),
    location: userLocation(user.id),
  };

  // Heurística para givenName/familyName desde User.name (string libre):
  //   - "Juan Pérez"   → given='Juan', family='Pérez'
  //   - "Juan Carlos Pérez" → given='Juan Carlos', family='Pérez'
  //   - "Juan"         → given='Juan', family undefined
  //   - null           → no incluimos `name`
  let scimName: ScimUser['name'] = undefined;
  if (user.name && user.name.trim().length > 0) {
    const parts = user.name.trim().split(/\s+/);
    if (parts.length === 1) {
      scimName = { givenName: parts[0]!, formatted: user.name };
    } else {
      const family = parts[parts.length - 1]!;
      const given = parts.slice(0, -1).join(' ');
      scimName = { givenName: given, familyName: family, formatted: user.name };
    }
  }

  // active = true para ACTIVE / PENDING (el usuario puede recibir invite y
  // autenticarse). false para SUSPENDED / DEACTIVATED.
  const isActive = user.status === 'ACTIVE' || user.status === 'PENDING';

  const out: ScimUser = {
    schemas: [SCIM_SCHEMAS.USER],
    id: user.id,
    userName: user.email,
    active: isActive,
    displayName: user.name ?? user.email,
    emails: [
      {
        type: 'work',
        primary: true,
        value: user.email,
      },
    ],
    locale: user.locale,
    meta,
    ...(scimName ? { name: scimName } : {}),
    // Devolvemos id como externalId también (espejo) — esto es válido SCIM
    // y permite que el IdP almacene un solo identificador.
    externalId: user.id,
  };

  return out;
}

/**
 * Datos extraídos del DTO SCIM para crear un User interno.
 *
 * El service recibe esto y se encarga de:
 *   - validar email único per tenant
 *   - generar el password reset (si decide hacerlo — el piloto NO envía email)
 *   - persistir
 */
export interface ScimUserCreateInput {
  email: string;
  name: string | null;
  active: boolean;
  locale: string | null;
}

/**
 * Convierte un payload de POST /Users SCIM al input del service.
 *
 * Reglas de derivación del email:
 *   1. `userName` si parece email.
 *   2. `emails` con `primary=true`.
 *   3. Primer email de la lista.
 * Si nada de eso resuelve a un email válido → null y el caller decide (el
 * service rechaza con 400 SCIM scimType=invalidValue).
 */
export function scimToUserCreate(dto: ScimCreateUserDto): ScimUserCreateInput {
  const email = pickEmail(dto);
  const name = pickName(dto);
  const active = dto.active ?? true;
  const locale = dto.locale ?? null;

  return {
    email: email ?? '',
    name,
    active,
    locale,
  };
}

function pickEmail(dto: ScimCreateUserDto): string | null {
  const candidates: string[] = [];
  if (typeof dto.userName === 'string' && dto.userName.length > 0) {
    candidates.push(dto.userName.trim());
  }
  if (Array.isArray(dto.emails)) {
    const primary = dto.emails.find((e) => e?.primary === true);
    if (primary?.value) candidates.push(primary.value.trim());
    for (const e of dto.emails) {
      if (e?.value) candidates.push(e.value.trim());
    }
  }
  for (const c of candidates) {
    if (looksLikeEmail(c)) return c.toLowerCase();
  }
  return null;
}

function pickName(dto: ScimCreateUserDto): string | null {
  if (dto.name?.formatted && dto.name.formatted.trim().length > 0) {
    return dto.name.formatted.trim();
  }
  const given = dto.name?.givenName?.trim();
  const family = dto.name?.familyName?.trim();
  if (given && family) return `${given} ${family}`;
  if (given) return given;
  if (family) return family;
  if (dto.displayName && dto.displayName.trim().length > 0) {
    return dto.displayName.trim();
  }
  return null;
}

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
