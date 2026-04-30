/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTOs Zod para los endpoints SCIM 2.0 (séptimo piloto License SDK).
 *
 * Validación deliberadamente PERMISIVA en algunos campos (vendor-specific):
 *   - `userName` lo aceptamos como string no vacío, pero el service exige
 *     que sea un email válido (mapping userName → email del User interno).
 *     Así un IdP que mande `juan-perez` se rechaza con 400 SCIM.
 *   - `externalId` se acepta como string opcional sin validación adicional —
 *     cada IdP lo usa con shape distinto (UUID, GUID, hash custom).
 *
 * Validación de PATCH: SCIM 2.0 (RFC 7644 §3.5.2) define operaciones con
 * `op`, `path` opcional y `value`. Soportamos:
 *   - `op: replace` con `path: active` y `value: boolean` → activar/desactivar.
 *   - `op: replace` con `path: name.givenName / name.familyName` → renombrar.
 *   - `op: replace` con `path: locale` → cambiar locale.
 *   - `op: replace` SIN path con value=objeto → reemplazo parcial.
 *
 * Cualquier otra combinación → 400 SCIM con scimType=invalidPath /
 * invalidSyntax. Mantenemos el set acotado a propósito: los IdP modernos
 * (Okta SCIM 2.0, Azure AD, Auth0, Google Workspace) emiten exactamente
 * estos shapes.
 */

import { z } from 'zod';

/**
 * Email reutilizable (regex muy laxa — los emails inválidos los pillará el
 * provider de mail si intentamos enviarles algo). Sigue el patrón que ya usan
 * los DTOs de auth.
 */
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scimEmail = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((v) => emailRegex.test(v), { message: 'email inválido' });

/** Schema de un email SCIM dentro de la lista emails. */
export const scimEmailSchema = z.object({
  type: z.string().trim().min(1).max(32).optional(),
  primary: z.boolean().optional(),
  value: scimEmail,
});

/** Schema del name estructurado. */
export const scimNameSchema = z
  .object({
    givenName: z.string().trim().min(1).max(120).optional(),
    familyName: z.string().trim().min(1).max(120).optional(),
    formatted: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

/**
 * Schema para POST /Users.
 *
 * RFC 7643 §4.1: el único campo requerido del User core es `userName`. El
 * resto opcionales. Si el IdP no envía `active`, asumimos `true` (los IdP
 * suelen mandar usuarios habilitados por defecto).
 */
export const scimCreateUserSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    userName: z.string().trim().min(1).max(254),
    externalId: z.string().trim().min(1).max(254).optional(),
    active: z.boolean().optional().default(true),
    name: scimNameSchema.optional(),
    displayName: z.string().trim().min(1).max(240).optional(),
    emails: z.array(scimEmailSchema).max(10).optional(),
    locale: z.string().trim().min(2).max(20).optional(),
  })
  // Los IdPs envían meta a veces — lo aceptamos pero ignoramos (read-only del
  // lado del servidor). Strict() rompería con muchos clientes.
  .passthrough();

export type ScimCreateUserDto = z.infer<typeof scimCreateUserSchema>;

/**
 * Schema para PATCH /Users/:id.
 *
 * Cada Operation = { op, path?, value }. Solo aceptamos `replace` por
 * simplicidad (los IdPs lo usan para casi todo: activar/desactivar, renombrar,
 * cambiar email…).
 */
const scimPatchOpSchema = z.object({
  op: z.enum(['replace', 'add', 'remove']),
  path: z.string().trim().min(1).max(120).optional(),
  // value puede ser cualquier JSON: boolean, string, número, objeto, array.
  // Lo dejamos como `unknown` y lo procesamos en el service según el `path`.
  value: z.unknown().optional(),
});

export const scimPatchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(scimPatchOpSchema).min(1).max(20),
});

export type ScimPatchDto = z.infer<typeof scimPatchSchema>;
export type ScimPatchOp = z.infer<typeof scimPatchOpSchema>;

/**
 * Query params de GET /Users (paginación SCIM).
 *
 * RFC 7644 §3.4.2:
 *   - `startIndex` 1-based (¡no 0!), default 1.
 *   - `count` default y máximo dependientes del servidor — fijamos defaults
 *     razonables: default 50, máx 200.
 *   - `filter` string opcional, soporte mínimo: `userName eq "..."`.
 *
 * No soportamos `attributes` ni `excludedAttributes` (el cliente que llame
 * que se quede con todo el recurso — es info no sensible).
 */
export const scimListQuerySchema = z.object({
  startIndex: z.coerce.number().int().positive().default(1),
  count: z.coerce.number().int().min(0).max(200).default(50),
  filter: z.string().trim().min(1).max(500).optional(),
});

export type ScimListQueryDto = z.infer<typeof scimListQuerySchema>;
