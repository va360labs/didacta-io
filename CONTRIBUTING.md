# Contributing to Didacta Community

> Gracias por tu interés en contribuir a Didacta. Esta guía resume el proceso. Tómate 5 minutos para leerla antes de abrir tu primer PR.

## Antes de empezar

### Estado actual: alpha cerrada

Este repositorio está en **alpha cerrada** mientras trabajamos hacia `v1.0.0`. Las contribuciones externas se aceptan **solo de alpha testers invitados** durante esta fase. Cuando hagamos público el repo (Fase 7 / `v1.0.0`), se abrirán las contribuciones a toda la comunidad.

### Licencia

Didacta es **fair-code source-available**, no open source bajo definición OSI. Lee:

- [`LICENSE`](LICENSE) — Didacta Sustainable Use License v1.0 (cubre la mayor parte del repo).
- [`LICENSE_EE`](LICENSE_EE) — Didacta Enterprise License (cubre archivos `*.ee.*` y carpetas `ee/` / `*.ee/` dentro del CORE).
- [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md) — resumen humano.

## Tu primera contribución

### 1. Bot CLA

Cualquier PR es bloqueado hasta firmar el CLA (Contributor License Agreement) vía [cla-assistant.io](https://cla-assistant.io). El bot te lo pedirá automáticamente la primera vez. **Una sola firma vale para todas tus contribuciones futuras.**

### 2. Issue antes de PR

Para cambios no triviales, abre primero una **issue** describiendo el problema o la propuesta. Eso evita trabajo descartado si la dirección no encaja con el roadmap. Para fixes pequeños (typo, doc) puedes ir directo al PR.

### 3. Branch

```bash
git checkout -b <type>/<short-description>
```

Tipos válidos: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`, `perf/`.

### 4. Conventional Commits obligatorios

```
feat(scope): título corto

Cuerpo opcional. Explica el POR QUÉ, no el QUÉ (eso ya lo dice el diff).

Refs: #123
```

Sin atribución a IA en commits (sin `Co-Authored-By: Claude` ni similar). Política del proyecto.

### 5. Tests

Cualquier PR que toque lógica de negocio debe incluir tests. Coverage mínimo 70% en services.

### 6. Validaciones obligatorias antes de push

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm tsx scripts/ee-fence.ts
pnpm tsx scripts/module-doctor.ts
```

CI las ejecuta otra vez. Si fallan, el PR no se mergea.

## Reglas duras del modelo

Estas reglas son **innegociables**. Romperlas = PR rechazado.

### Convención `.ee` (open-core)

- Archivos `*.ee.ts` y carpetas `ee/` / `*.ee/` viven **solo dentro del CORE** (`apps/api/src/...`, `packages/core-kernel/`, `packages/license-sdk/src/`).
- **Ningún módulo** (`modules/*`) puede tener archivos `.ee` ni sufijo `.ee` en su carpeta. Todos los módulos son Community.
- Capabilities Enterprise se gatean con `@RequiresCapability(LICENSE_CAPABILITIES.X)` en endpoints y `license.requireCapability(...)` en services.

### Contrato de módulo

- Todas las tablas con prefijo `mod_<nombre>_*` y `tenant_id` con RLS.
- Cero FKs cross-module.
- Cero imports de código privado de otro módulo. Comunicación vía eventos / hooks / API pública.
- `module.json` válido contra schema.
- Lifecycle hooks (`onRegister`, `onEnable`, `onDisable`, `onUninstall`) implementados.

### No introducir dependencias copyleft

- ✅ MIT, Apache 2.0, BSD, ISC.
- ⚠️ LGPL (caso a caso, solo si linkado dinámico).
- ❌ GPL, AGPL, MPL, SSPL.

CI corre `scripts/license-check.ts` y rechaza el PR si hay dependencia incompatible.

## Estilo de código

- TypeScript estricto. No `any` salvo casos justificados (con comentario).
- Prettier + ESLint. CI lo verifica.
- Identificadores en inglés. Comentarios y commits en español o inglés indistintamente.
- Sin `console.log` en código de producción — usa el logger Pino.

## Reportar bugs

Si eres **alpha tester**, sigue [`docs/alpha/FEEDBACK.md`](docs/alpha/FEEDBACK.md).

Si encuentras una vulnerabilidad de seguridad, **NO abras issue público**. Manda un email a `security@didacta.io`. Ver [`SECURITY.md`](SECURITY.md).

## Decisiones arquitectónicas

Cualquier cambio que afecte al contrato de módulo, al modelo de licencias, al SDK o a APIs públicas requiere **ADR** previa. Las ADRs viven en `docs/adrs/`. Plantilla: ADR-008.

## Política de marca

El nombre "Didacta", el logo y derivados son marcas registradas de VA360 LABS S.L. Lee [`TRADEMARKS.md`](TRADEMARKS.md) antes de mencionarlos en proyectos derivados o forks.

## Reconocimiento

Las contribuciones aceptadas aparecen en `CONTRIBUTORS.md` (con tu consentimiento) cuando publiquemos `v1.0.0`.

## Contacto

- 💬 Preguntas técnicas: GitHub Discussions o Discord `#didacta-alpha` (durante alpha).
- 🔒 Seguridad: `security@didacta.io`.
- 📜 Licensing / comercial: `licensing@didacta.io`.

Gracias por contribuir. 🚀
