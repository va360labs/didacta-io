/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

const SemVerRange = z
  .string()
  .regex(/^[\^~]?\d+\.\d+\.\d+/, 'Debe ser un rango SemVer válido (ej. ^1.0.0)');

const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Debe ser una versión SemVer válida (ej. 1.0.0)');

export const moduleDependencySchema = z.object({
  name: z.string().min(1),
  version: SemVerRange,
});

export const roleDefinitionSchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export const hookDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  async: z.boolean().default(true),
});

export const uiExtensionSchema = z.object({
  slot: z.string().min(1),
  component: z.string().min(1),
});

export const pageDefinitionSchema = z.object({
  path: z.string().startsWith('/', 'El path debe comenzar con /'),
  component: z.string().min(1),
});

export const moduleManifestSchema = z.object({
  name: z
    .string()
    .regex(
      /^(core|mod\.[a-z0-9-]+)$/,
      'El nombre debe ser "core" o empezar con "mod." (ej. mod.courses)',
    ),
  displayName: z.string().min(1),
  description: z.string().min(1),
  version: SemVer,
  author: z.string().optional(),
  license: z.string().optional(),
  category: z.string().optional(),
  coreVersionRequired: SemVerRange,
  dependencies: z
    .object({
      modules: z.array(moduleDependencySchema).default([]),
      optionalModules: z.array(moduleDependencySchema).default([]),
    })
    .default({ modules: [], optionalModules: [] }),
  tablePrefix: z
    .string()
    .regex(/^mod_[a-z0-9_]+_$/, 'El prefijo debe seguir el patrón mod_<nombre>_'),
  permissions: z.array(z.string()).default([]),
  roles: z.array(roleDefinitionSchema).default([]),
  eventsEmitted: z.array(z.string()).default([]),
  eventsConsumed: z.array(z.string()).default([]),
  hooksExposed: z.array(hookDefinitionSchema).default([]),
  hooksConsumed: z.array(z.string()).default([]),
  defaultConfig: z.record(z.string(), z.unknown()).default({}),
  uiExtensions: z.array(uiExtensionSchema).default([]),
  pages: z.array(pageDefinitionSchema).default([]),
  apiNamespace: z.string().startsWith('/', 'El apiNamespace debe comenzar con /'),
});

export type ModuleDependency = z.infer<typeof moduleDependencySchema>;
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;
export type UIExtension = z.infer<typeof uiExtensionSchema>;
export type PageDefinition = z.infer<typeof pageDefinitionSchema>;
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export class ModuleManifestValidationError extends Error {
  constructor(
    public readonly issues: z.ZodIssue[],
    public readonly manifestName?: string,
  ) {
    const header = manifestName
      ? `Manifest inválido en módulo "${manifestName}"`
      : 'Manifest inválido';
    const details = issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    super(`${header}\n${details}`);
    this.name = 'ModuleManifestValidationError';
  }
}

export function parseModuleManifest(input: unknown): ModuleManifest {
  const result = moduleManifestSchema.safeParse(input);
  if (!result.success) {
    const name =
      typeof input === 'object' && input !== null && 'name' in input
        ? String((input as { name: unknown }).name)
        : undefined;
    throw new ModuleManifestValidationError(result.error.issues, name);
  }
  return result.data;
}
