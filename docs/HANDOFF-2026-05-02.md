# HANDOFF — Didacta Community (2026-05-02, sesión maratón: alpha.11 → alpha.32)

> Documento de transferencia entre sesiones de Claude Code.
> Léeme entero antes de empezar nuevas tareas.
> Reemplaza al `HANDOFF-2026-05-04.md` (queda como referencia previa al rollout marketplace).
> El `HANDOFF-2026-05-02-art.md` es de una sesión paralela anterior del mismo día (ART-002 + ART-010).

---

## 1. Quién soy y dónde estoy

- **Repo de trabajo**: `D:\Test\didacta-community` (Windows + Git Bash).
- **Repos relacionados** (NO modificar sin permiso explícito):
  - `D:\Test\learnship` — orchestrator (CWD del agente).
  - `D:\Test\didacta-cloud` — repo privado con `apps/license-issuer/` (skeleton MVP creado en esta sesión).
  - `D:\Test\didacta-modules-skill` — skills/agents para asistentes IA del ecosistema.
- **Branch activo**: `main` sincronizado con `origin/main`. Último push: `0dca50e`.
- **Stack**: NestJS 11 + Next.js 15 + Postgres 16 (pgvector + RLS lógico) + Redis 7 + MinIO + Prisma 5.
- **Idioma**: español **neutro** (NO voseo) en commits, comentarios, docs y UI. Identificadores técnicos en inglés. Auditoría completa en alpha.27.
- **Convenciones git**: Conventional Commits, NUNCA "Co-Authored-By", NUNCA `--no-verify` sin pedir permiso.
- **Backlog operativo**: Notion → LMS Ship → Work Items database (`aa00fff5-f15f-4294-8ddd-864047e5a4ac`). GitHub Issues NO se usa como tracker.

---

## 2. Estado actual — qué está hecho hoy

### 2.1 Imágenes Docker publicadas

- **Registry primario**: Docker Hub, namespace `didactaio`.
  - `docker.io/didactaio/community:0.0.1-alpha.32` — sha256:`ceb32f0d07a391d2787b50676d9280bffb30abda489f22ec49e6841a116bb200` (ÚLTIMA, smoke real OK)
  - `docker.io/didactaio/community:alpha` (rolling, mismo digest)
  - `docker.io/didactaio/community:0dca50e` (commit short SHA)
- **Tamaño**: ~1.3 GB (alpine + monorepo prunado).
- **GHCR**: sigue bloqueado por billing suspendido en `va360labs`. NO BLOQUEANTE.

### 2.2 Sesión productiva: 22 releases en orden cronológico

| Tag | Cambio principal |
|---|---|
| `alpha.11` | Rollout completo ADR-009 marketplace (PRs A→F apilados, mergeados todos). Validate firma + storage + migrations SQL + VM aislada + lint + onInstall + runtime router + UI drag&drop. 134 tests. |
| `alpha.12` | Toggle `DIDACTA_REQUIRE_MFA_ADMIN`. **INCOMPLETO** — solo afectaba sign-in. |
| `alpha.13` | Fix MFA: el toggle ahora aplica también a `JwtAuthGuard`. **Default: NO obligatorio.** Opt-in con `=true`. |
| `alpha.14` | Setup wizard: voseo→neutro + nuevo step "Módulos" con selección durante onboarding. |
| `alpha.15` | Middleware bloquea TODA la app antes del onboarding (no solo `/signin`). |
| `alpha.16` | Filtra tabs en `/admin/configuracion` por módulo activo (`requiresModule`). Audit voseo en apps/web (parcial). |
| `alpha.17` | **Refactor `mod.zoom-live` self-contained** (ADR-011 nueva). Backend a `modules/zoom-live/` + frontend a `apps/web/src/modules/zoom-live/` + extension point `ModuleWebExtension`. |
| `alpha.18` | Strict mode + listener `didacta:modules-changed` para filtro de tabs. **Backend NO arrancaba** por DI circular. |
| `alpha.19` | **Fix DI circular** `ZoomLiveModule ↔ ModulesModule` con `forwardRef()`. Convención obligatoria para sub-modules según ADR-011. |
| `alpha.20` | Versión + canal en pie del sidebar (`apps/web/src/lib/version.ts` hard-coded). |
| `alpha.21` | Refactor `mod.notifications` self-contained (parcial: solo Plantillas, SMTP queda como infra compartida). |
| `alpha.22` | Banner "versión nueva" con polling a Docker Hub (opción C). **CORS bloqueaba** el fetch directo. |
| `alpha.23` | Fix CORS: proxy server-side `/api/v1/system/version-check` con cache 4h. |
| `alpha.24` | Bump para validar banner aparece en alpha.23. |
| `alpha.25` | Bump para validar banner — pero el cache server-side de 4h tapaba alpha.25. |
| `alpha.26` | TTL del proxy 4h → 15min (alpha sale demasiado seguido). |
| `alpha.27` | **Audit completo español neutro** en TODO el repo (apps/api + apps/web + packages). 42 archivos. `toLocaleDateString('es-AR') → 'es-ES'`. |
| `alpha.28` | Paquetes de módulos pasan de `.didactamod` → `.zip` plano. Skill `package-module` añadida en `didacta-modules-skill`. |
| `alpha.29` | Cliente `sign-package.ts --remote-issuer` para firmar via API del `apps/license-issuer` (didacta-cloud). |
| `alpha.30` | Fix `awsKmsSign()`: KMS firmaba el base64 del message en lugar del message. |
| `alpha.32` | **Fix Dockerfile pruner** borraba `packages/license-sdk/src/public-keys/`. Pem rescatado a sibling fuera de `src/`. **End-to-end firma KMS funciona.** |

### 2.3 Hitos arquitectónicos

- **ADR-011 — Módulos self-contained**: `docs/adrs/ADR-011-modulo-self-contained.md`. Todo código del módulo (back + front + assets) bajo `modules/<name>/`. Aplicado a `mod.zoom-live` y `mod.notifications` (parcial).
- **Marketplace ADR-009 implementado end-to-end**: validate firma KMS ES256 → storage → migrations SQL → VM aislada (`node:vm`) → lint estático → boot `onInstall` → runtime router + dispatcher (`/api/v1/modules/<slug>/*`) → UI super_admin con drag&drop.
- **Firma KMS productiva**: `apps/license-issuer/` skeleton MVP en `didacta-cloud` con endpoint `POST /v1/modules/sign-manifest`. Cliente `--remote-issuer` en este repo. Workflow GitHub Actions `sign-module.yml`. Runbook completo en `didacta-cloud/runbooks/license-issuer-deploy.md`.
- **Configuración firmador local funcional** (modo express): el user `didacta-kms-admin` tiene `kms:Sign` desde hoy. Permite ejecutar `scripts/marketplace/sign-package.ts` desde la máquina del operador hasta que se deploye el license-issuer.
- **Smoke firma KMS validado end-to-end**: `mod.hello-1.0.0.zip` (en `D:\Test\.tmp-test-module\output\`) firmado con KMS real instala sin setup adicional en `manage-alphadidacta.3qntut.easypanel.host`.

### 2.4 Banner de versión nueva (proxy + polling)

- **Backend**: `apps/api/src/system/version-check.controller.ts`. Endpoint público `GET /api/v1/system/version-check` que cachea 15 min en memoria los tags de Docker Hub.
- **Frontend**: `apps/web/src/lib/version-check.ts` + `version-update-banner.tsx`. Polling cada 30 min. Banner amber bajo el footer del sidebar con link a Docker Hub + dismiss persistente en localStorage.
- **Funciona en producción**: el deploy del user vio alpha.26 anunciar alpha.27 sin tocar nada.

---

## 3. Decisiones arquitectónicas tomadas en esta sesión

### 3.1 Módulos self-contained (ADR-011)

Regla del repo: cualquier PR que añada UI de un módulo fuera de `modules/<name>/` se rechaza en review. El core importa solo del catálogo agregado `apps/web/src/modules/index.ts`. Cuando el marketplace runtime esté operativo, el catálogo se reemplaza por un loader dinámico — la interfaz `ModuleWebExtension` no cambia.

Excepciones documentadas:
- `SmtpAdapterService` y `PrismaNotificationHubService` (mod.notifications) son **infraestructura compartida** del core porque auth/billing también las consumen. NO se mueven al sub-module. El tab "Notificaciones · SMTP" sigue en core pendiente de migración a `/admin/email`.

### 3.2 Forward-ref obligatorio para sub-modules

Cualquier `<Name>Module` que inyecte servicios del padre `ModulesModule` (ej. `ModuleRegistryService`) debe usar `forwardRef(() => ModulesModule)` y el padre debe usar `forwardRef(() => <Name>Module)` recíprocamente. Sin esto el DI graph es circular y NestJS falla con "Nest can't resolve dependencies". Aplicado a `ZoomLiveModule` y `NotificationsModule`.

### 3.3 Smoke `docker run` antes de cada release

Tras alpha.18 que NO arrancaba (bug DI no detectable en `docker build`), añadí smoke con `docker run --rm` que verifica que el DI graph se inicializa. Workflow:
```bash
docker run --rm --entrypoint sh -e AUTH_SECRET=$(node -e "console.log('a'.repeat(32))") \
  -e DATABASE_URL="postgresql://x:x@localhost:5432/x?schema=public" \
  didactaio/community:<tag> -c \
  'cd /repo/apps/api && timeout 6 node dist/main.js 2>&1 | grep -E "ERROR|Nest can|Cannot resolve" | head -5'
```
Si devuelve líneas, NO push. Si devuelve nada (cae en `prisma.connect()` por BD ausente), DI OK.

### 3.4 Firma KMS productiva = pem rescatado del pruner

`packages/license-sdk/src/public-keys/*.pem` se copia a `packages/license-sdk/public-keys/` (sibling fuera de `src/`) ANTES del rm del pruner. El resolver del verifier prueba ambos paths. Sin esto, la imagen de producción no tenía con qué verificar JWTs firmados.

---

## 4. Estructura de repos relevante

```
D:/Test/
├── didacta-community/          # repo público alpha (este)
├── didacta-cloud/              # repo privado, contiene license-issuer
├── didacta-modules-skill/      # skills compartidas para asistentes IA
└── .tmp-test-module/           # NO commiteado, contiene mod.hello-1.0.0.zip de prueba
    └── output/
        └── mod.hello-1.0.0.zip # firmado por KMS, instalable directo
```

---

## 5. Variables de entorno (estado completo)

### Nuevas en esta sesión
- `DIDACTA_REQUIRE_MFA_ADMIN=true` (opt-in, default OFF) — fuerza MFA en roles admin.
- `MARKETPLACE_PUBLIC_KEYS_DIR` (opcional override) — donde el verifier carga `*.pem`. Default: el rescatado del pruner.
- `DIDACTA_CORE_VERSION` (recomendada en CI/CD) — SemVer del core para validar `coreVersionRequired` de los módulos del marketplace.

### Existentes que el marketplace usa
- `STORAGE_DRIVER` + `S3_*` — persistencia de los `.zip` (mismo storage del core).
- `DATABASE_URL` — tablas `installed_module` + `migrations_applied`.
- `AUTH_SECRET` — JWT signing del core.

---

## 6. Pendiente del rollout self-contained (ADR-011)

| Módulo | Backend ya separado | Frontend a migrar | Esfuerzo |
|---|---|---|---|
| `mod.zoom-live` | ✅ alpha.17 | ✅ admin tab + sidebar | DONE |
| `mod.notifications` | ✅ alpha.21 (parcial) | ⚠️ tab Plantillas DONE, SMTP queda en core | DONE con excepción |
| **`mod.fundae`** | pendiente | `/admin/fundae/*` (5+ páginas) | **L — SIGUIENTE** |
| `mod.billing` | pendiente | `/admin/billing/products` + checkout | L |
| `mod.community` | pendiente | digestor metrics + UI | M |
| `mod.certificates` | pendiente | templates + mis-certificados | M |
| `mod.assessments` | pendiente | quiz editor + attempts | L |
| `mod.ai-tutor` | pendiente | `lib/ai-tutor.ts` | M |
| `mod.ai-grader` | pendiente | tab IA + clientes | M |
| `mod.ai-content` | pendiente | clientes | M |

---

## 7. Configuración AWS / KMS

- Account: `198233242015`.
- Key: `alias/didacta-issuer-2026` (eu-west-1, ECDSA P-256, ES256).
- User actual con `kms:Sign`: `didacta-kms-admin` (modo express, opción A — hoy operativo).
- Pendiente Fase 4: crear role `didacta-license-issuer` con `kms:Sign` único, deploy de `apps/license-issuer/` en infra estable, configurar OIDC GitHub Actions trust.
- Runbook completo: `didacta-cloud/runbooks/license-issuer-deploy.md`.

---

## 8. Cómo testear el flujo end-to-end del marketplace HOY

```bash
# 1. Generar manifest + dist del módulo (en D:/Test/.tmp-test-module/build/).
# 2. Firmar con KMS local (user didacta-kms-admin tiene Sign):
cd D:/Test/didacta-community
./node_modules/.bin/tsx scripts/marketplace/sign-package.ts \
  --manifest D:/Test/.tmp-test-module/build/manifest.json \
  --dist     D:/Test/.tmp-test-module/build/dist \
  --out      D:/Test/.tmp-test-module/output/<name>-<version>.zip \
  --kid      didacta-issuer-2026

# 3. Verificar firma valida contra pública del repo:
./node_modules/.bin/tsx -e "
  const fs = require('fs');
  const AdmZip = require('adm-zip');
  const { jwtVerify, importSPKI } = require('jose');
  (async () => {
    const zip = new AdmZip('D:/Test/.tmp-test-module/output/<name>-<version>.zip');
    const jwt = zip.readAsText('manifest.jwt').trim();
    const pem = fs.readFileSync('packages/license-sdk/src/public-keys/didacta-issuer-2026.pem', 'utf8');
    const key = await importSPKI(pem, 'ES256');
    await jwtVerify(jwt, key, { issuer: 'didacta.io', audience: 'didacta-marketplace' });
    console.log('OK');
  })().catch(e => { console.error('FAIL', e.message); process.exit(1); });
"

# 4. Subir el .zip a /admin/marketplace en cualquier instancia con alpha.32+.
```

---

## 9. Próxima sesión — siguiente issue

**Notion**: `FR-MOD-MIGRATE-FUNDAE` — *Migrar mod.fundae a self-contained (ADR-011)*.
URL: https://www.notion.so/354b609a124c8174b808ca2c14dd477d
Estado: Backlog · Effort: L · Fase: 1.B · Módulo: mod.fundae · Prioridad: P2.

Por qué este: aplica el mismo patrón ya validado dos veces (zoom-live + notifications). Es el más visible del backlog porque tiene 5+ páginas dedicadas (`/admin/fundae/*`). Cada migración refuerza la convención y reduce la deuda arquitectónica residual del core.

Pasos previstos:
1. Mover backend a `apps/api/src/modules/fundae/` + crear `FundaeModule` con `forwardRef`.
2. Crear `apps/web/src/modules/fundae/` con cliente HTTP + componentes UI.
3. Páginas Next como wrappers que importan del módulo.
4. Smoke `docker run` antes de push.
5. Bump alpha.33 + push imagen.
6. Si UI rota tras migración → diagnóstico end-to-end con DevTools.

---

## 10. Notion work items vivos

- ADR-009 PRs A-F: TODOS Hecho ✅ (mergeados en alpha.11).
- ADR-010 (pairing instancia↔cuenta web): Propuesto. Bloqueado por web didacta.io no construida.
- HU-MKT-001 (push install desde marketplace web): Backlog. Bloqueado por ADR-009 + ADR-010 + KMS + CDN + web.
- FR-MOD-MIGRATE-FUNDAE: Backlog (creado hoy). **Siguiente.**
