# `scripts/` — Scripts de validación y operación

Estos scripts forman parte de la garantía de calidad del repo. Se ejecutan en CI y localmente.

## Scripts disponibles

| Script             | Propósito                         | Uso típico                          |
| ------------------ | --------------------------------- | ----------------------------------- |
| `ee-fence.ts`      | Valida convención `.ee` open-core | `pnpm tsx scripts/ee-fence.ts`      |
| `module-doctor.ts` | Valida contrato de módulo         | `pnpm tsx scripts/module-doctor.ts` |
| `license-check.ts` | Audita licencias de dependencias  | `pnpm tsx scripts/license-check.ts` |

## Ejecutar los tres antes de un PR

```bash
pnpm tsx scripts/ee-fence.ts \
  && pnpm tsx scripts/module-doctor.ts \
  && pnpm tsx scripts/license-check.ts
```

CI ejecuta esto en cada PR. Si rojo localmente → arregla antes de hacer push.

## Cómo añadir un script nuevo

1. Crear `scripts/<nombre>.ts` siguiendo el estilo de los existentes (shebang `#!/usr/bin/env tsx`, comentario inicial con propósito y uso).
2. Añadir entrada en este README.
3. Si es bloqueante, añadirlo al workflow `.github/workflows/<nombre>.yml`.
4. Documentar en `docs/scripts.md` si es relevante para devs.

## Dependencias

- `tsx` (runtime TypeScript en CLI).
- `glob` para `ee-fence.ts`.
- `pnpm licenses list --json` (built-in en pnpm 9+) para `license-check.ts`.
