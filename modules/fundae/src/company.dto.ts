/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import { isValidSpanishTaxId, normalizeSpanishTaxId } from './spanish-tax-id.js';

/**
 * DTO de empresa bonificada Fundae (LMS-79).
 *
 * El NIF se normaliza siempre antes de validar (mayúsculas, sin
 * separadores) para evitar duplicados por formato — luego se persiste
 * normalizado en la columna `nif` con UNIQUE (tenant, nif).
 *
 * Los importes monetarios se transmiten por API en céntimos (Int) para
 * evitar errores de redondeo al cuadrar costes con Fundae.
 */

export const datosContactoSchema = z
  .object({
    direccion: z.string().max(200).optional(),
    ciudad: z.string().max(120).optional(),
    codigoPostal: z
      .string()
      .regex(/^\d{5}$/, 'Código postal español: 5 dígitos')
      .optional(),
    provincia: z.string().max(120).optional(),
    pais: z.string().max(2).default('ES').optional(),
    contactoNombre: z.string().max(200).optional(),
    contactoEmail: z.string().email().max(200).optional(),
    contactoTelefono: z.string().max(40).optional(),
  })
  .strict();

export type DatosContactoDto = z.infer<typeof datosContactoSchema>;

export const createCompanySchema = z.object({
  nif: z
    .string()
    .min(1)
    .max(20)
    .transform((v) => normalizeSpanishTaxId(v))
    .refine((v) => isValidSpanishTaxId(v), {
      message: 'NIF español inválido (acepta DNI, NIE o CIF con checksum correcto).',
    }),
  razonSocial: z.string().min(1).max(200),
  /** 11 dígitos como string para preservar ceros líderes. Opcional. */
  cccPrincipal: z
    .string()
    .max(15)
    .regex(/^\d{8,15}$/, 'Código Cuenta Cotización: 8-15 dígitos')
    .optional(),
  plantilla: z.number().int().min(0).max(1_000_000).optional(),
  /** Crédito Fundae anual en céntimos. Si null, no se controla cap. */
  creditoTotalCents: z.number().int().min(0).max(999_999_999_99).optional(),
  datosContacto: datosContactoSchema.optional(),
  notas: z.string().max(2000).optional(),
});
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

/**
 * En update no se permite editar el NIF — si la empresa cambia de NIF
 * (fusión, alta nueva, cambio de personalidad jurídica) hay que crear
 * una empresa nueva por trazabilidad. El service también rechaza el
 * cambio si llega.
 */
export const updateCompanySchema = z.object({
  razonSocial: z.string().min(1).max(200).optional(),
  cccPrincipal: z
    .string()
    .max(15)
    .regex(/^\d{8,15}$/, 'Código Cuenta Cotización: 8-15 dígitos')
    .nullable()
    .optional(),
  plantilla: z.number().int().min(0).max(1_000_000).nullable().optional(),
  creditoTotalCents: z.number().int().min(0).max(999_999_999_99).nullable().optional(),
  datosContacto: datosContactoSchema.optional(),
  notas: z.string().max(2000).nullable().optional(),
});
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

export interface CompanyView {
  id: string;
  tenantId: string;
  nif: string;
  razonSocial: string;
  cccPrincipal: string | null;
  plantilla: number | null;
  creditoTotalCents: number | null;
  creditoUsadoCents: number;
  /** `creditoTotalCents - creditoUsadoCents`. Null si no hay total fijado. */
  creditoDisponibleCents: number | null;
  datosContacto: DatosContactoDto;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
