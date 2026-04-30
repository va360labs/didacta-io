# Demo Script — Didacta Community alpha

> Guion para demo en vivo de **15 minutos** dirigida a leads cualificados (academias formación, RRHH empresas, consultoras Fundae). El objetivo es **mostrar lo diferenciador, no lo común**.

## Pre-demo (5 min antes)

1. Stack alpha levantado: `docker compose -f docker-compose.alpha.yml up -d`.
2. Datos seed cargados: 1 tenant `acme` con 3 alumnos + 2 cursos (1 con SCORM, 1 con quiz IA-grader).
3. Licencia EE de demo cargada en env (con las 5 capabilities ya pilotadas activas) — para que el lead vea el comportamiento "con plan Enterprise".
4. Browser limpio en incógnito.
5. Logged in como `tenant_admin` ya en `/admin`.

---

## Apertura (1 min)

> "Lo que vais a ver es **alpha** — un milestone privado para 5-10 testers. No es producto comercial todavía, pero tiene los pilares cerrados de un LMS profesional + tres diferenciadores que no encontraréis en Moodle, LearnDash ni TalentLMS."

> "Es **fair-code source-available**, no tiene SaaS lock-in. Lo podéis self-host gratis indefinidamente. Solo se paga el plan Enterprise cuando necesitéis features de gran cuenta — SSO, multi-tenant estricto, branding completo, retención auditoría >90 días."

> "Stack: NestJS + Next 15 + Postgres con RLS + Redis + S3. 561 tests verde. 22 módulos respetando un contrato estricto verificado por linter automático. **Todo demostrable.**"

---

## Bloque 1 — IA por curso con citas verificables (3 min) ⭐

**Highlight: NO existe en Moodle ni LearnDash. Docebo y TalentLMS lo tienen, pero sin citas verificables.**

1. Logged como alumno → entrar a un curso ya publicado.
2. Click en el panel "Tutor IA" embebido lateral.
3. Pregunta: *"¿Qué dice la lección 3 sobre el RGPD?"*
4. La IA responde con un párrafo + **citas explícitas** (`[Lección 3, párrafo 2]`).
5. Click en la cita → te lleva al fragmento exacto de la lección.
6. **Diferenciador**: "AI Gateway multi-provider — Anthropic, OpenAI o Voyage. **Configurable por tenant**. Si Anthropic se cae, failover automático a OpenAI sin downtime."
7. **ROI**: "Un alumno con dudas no espera al formador. Resuelto en 30 segundos con cita verificable."

---

## Bloque 2 — Fundae España al 100% (3 min) ⭐

**Highlight: NINGÚN LMS comercial cubre Fundae con esta profundidad. Es el diferenciador comercial más fuerte para mercado español.**

1. Login como `tenant_admin` → `/admin/fundae`.
2. Crear empresa bonificada (NIF + CCC + plantilla).
3. Crear grupo bonificable con costes (€20 / hora · 10 alumnos · 30h).
4. Mostrar timeline: notificación RLPT → 15 días naturales obligatorios → activación.
5. Matricular 3 alumnos.
6. Avanzar a "grupo finalizado" — sistema calcula automáticamente ✅ alumnos completados ≥ 75%.
7. **Click "Generar XML inicio"** → descarga el XML formato Fundae listo para enviar.
8. **Click "Descargar ZIP de presentación"** → ZIP con `accion-{codigo}.xml` + `evidencia-{dni}.pdf` por participante + `manifest.json` con SHA-256.
9. **Diferenciador**: "Hay un script offline `tools/audit-zip-verify.mjs` que el auditor de Fundae puede correr en su máquina **sin internet** para verificar que el ZIP no se modificó. Hashes SHA-256 coinciden, firma OK, exit 0."
10. **ROI**: "Una academia que bonifica 50k€/año ahorra ~6k€ en plataforma + 100h/año de gestión manual. Payback en 3 meses."

---

## Bloque 3 — Modelo Enterprise honesto (4 min) ⭐

**Highlight: open-core honesto. Mostrar 5 capabilities EE pilotadas end-to-end con el toggle real funcionando.**

1. Volver a `/admin` → `/admin/branding`.
2. Mostrar editor con custom CSS + footer HTML — **gateado por `<EeGate>`**.
3. Sin licencia EE: muestra card "Función Enterprise — actualiza tu plan".
4. Cargar licencia EE de demo → recargar → editor white-label disponible.
5. Cambiar primary color, logo, custom CSS. Guardar.
6. Refresh del frontend del alumno → marca Didacta oculta, branding completo del tenant.
7. **`/admin/dominios`**: registrar `acme.example.com`. Sistema genera CNAME target + verification token. Status `pending`.
8. **`/admin/seguridad`**: política MFA tenant-wide → activar `requiredForAll` con grace 7 días. Si un alumno sin MFA configura: warn → grace → block después de 7 días.
9. **`/admin/auditoria`**: descargar audit log como ZIP firmado (HMAC-SHA256 + manifest sha256). Validador offline en `tools/audit-report-verify.mjs`.
10. **Highlight**: "Estas 5 capabilities están **gateadas por licencia firmada ES256**. Sin licencia, los endpoints devuelven 402 explicito. Con licencia válida, todo funciona. **Sin trampas — open-core honesto**."
11. **5 de 11 capabilities** ya pilotadas. Las 6 restantes (SSO SAML/OIDC, SCIM, multi-tenant real, webhooks, rate limit elevado) en roadmap Q3 2026.

---

## Bloque 4 — Modular extremo + tooling agnóstico IA (3 min)

**Highlight: el repo `didacta-modules-skill` permite que cualquier asistente IA (Claude Code, Copilot, Cursor, Aider) genere módulos correctos al primer intento.**

1. Mostrar terminal:
   ```bash
   node didacta-modules-skill/scripts/scaffold-module.mjs \
     --name marketplace --target ./modules --display-name "Marketplace"
   ```
2. 14 archivos generados en 2 segundos: manifest, prisma schema con prefijo + tenantId, service con CRUD ownership, dto Zod, errores tipados, tests, README.
3. Inmediatamente:
   ```bash
   node didacta-modules-skill/scripts/audit-module-contract.mjs \
     --modules-dir ./modules --module marketplace
   ```
4. Output: `✓ marketplace (0 violaciones) · ✓ AUDIT PASSED`.
5. **Highlight**: "El linter chequea **10 reglas auto-detectables** del contrato (prefijo `mod_*`, tenantId obligatorio, cero FKs cross-module, cero imports cross-module, eventos declarados, controllers bajo namespace, etc). Si un dev añade un módulo que rompe el contrato, **CI bloquea el PR**."
6. **Diferenciador**: "Esto es comparable al sistema de plugins de WordPress, pero con **contratos formales** verificados. Un cliente puede contratar a cualquier consultora externa y, si el módulo pasa el linter, va a integrar perfecto."

---

## Cierre (1 min)

> "Resumen de lo que habéis visto en 15 minutos:
> - **Core LMS** completo: cursos, SCORM, quizzes, certificados, comunidad, Zoom integrado.
> - **IA por curso** con citas verificables (NO existe en Moodle/LearnDash).
> - **Fundae España** end-to-end (NINGÚN LMS comercial).
> - **Open-core honesto**: 5 capabilities Enterprise pilotadas con gating real.
> - **Tooling agnóstico** para escalar el ecosistema sin lock-in.
>
> El alpha es privado por 4-6 semanas. Si os interesa probarlo:
> 1. Email a `alpha@didacta.io`.
> 2. Firmar NDA simple (1 página).
> 3. Acceso al repo privado + canal Discord + setup local en 10 minutos.
>
> El feedback de estas semanas decide qué entra en v0.1.0 público."

---

## Q&A típico — respuestas pre-cocidas

**P: ¿Por qué `Sustainable Use License v1.0` y no AGPL/MIT?**
R: Inspirada en n8n. Permite uso interno empresarial libre, restringe distribución de pago / SaaS competidor. Es fair-code calibrado: protege el negocio de VA360 sin asfixiar al usuario empresarial honesto.

**P: ¿Qué pasa si quiero white-label completo y NO quiero pagar EE?**
R: Forks privados están permitidos. Lo que NO se permite es vender Didacta a terceros como SaaS competidor. Para uso interno, ningún límite.

**P: ¿Migrator desde Moodle?**
R: En roadmap Q3 2026. Podemos hacer scoping conjunto si tu caso es prioritario.

**P: ¿SCORM 2004 + xAPI?**
R: SCORM 1.2 y 2004 ya. xAPI no en alpha — en roadmap.

**P: ¿Mobile?**
R: Web responsive ya. App nativa iOS/Android en roadmap Q4 2026.

**P: ¿Hosting / SaaS gestionado?**
R: Cloud (`cloud.didacta.io`) en construcción para clientes que no quieran self-host. Por ahora, recomendado Easypanel + VPS Hetzner — runbook en `docs/alpha/RUNBOOK.md`.

**P: ¿Qué hay del rendimiento? ¿Soporta 10k usuarios?**
R: Stack diseñado para escalar (Postgres con RLS + Redis + Outbox + EventBus persistente). Benchmarks formales aún no — en roadmap antes de v0.1.0 público. Pero el alpha actual va fluido con 100 usuarios concurrentes simulados en local.

**P: ¿Qué pasa si VA360 desaparece?**
R: El código es fair-code, los datos son tuyos en tu Postgres. La licencia te protege legalmente para seguir usándolo. Comunidad puede forkearlo.

---

## Demo bombshell para cerrar (opcional, 30 seg)

> "Última cosa: este script que acabáis de ver scaffoldeando un módulo en 2 segundos — **lo escribió Claude Code en una sesión de 4 horas siguiendo nuestras reglas del contrato**. Es producto operacional. Cualquiera de vosotros, con `didacta-modules-skill` clonado, puede crear módulos custom para vuestra organización **sin tocar el core**. Es tooling agnóstico de IA — funciona con Claude Code, Copilot, Cursor, Aider. **Ése es el futuro de cómo se construye software**: contratos formales + IA que respeta esos contratos al primer intento."

---

## Métricas a destacar (úselas si el lead pregunta)

- 561 tests automáticos verde (unit + integración Postgres real).
- 22 módulos verdes con linter `audit-module-contract` (10 reglas).
- 5 capabilities EE pilotadas end-to-end.
- 3 herramientas offline standalone (audit-zip-verify, audit-report-verify, scaffold-module).
- Imagen alpha 1.3 GB (Docker Hub público `didactaio/community`).
- Stack actual: NestJS 11 + Next 15 + Postgres 16 + Redis 7 + Prisma 5 + pgvector + S3.

## NO mencionar en demo a menos que pregunten

- Billing / Stripe / monetización (no implementado, deja sensación de inmadurez).
- App móvil nativa (no implementada).
- Marketplace módulos third-party (no implementado).
- Live streaming nativo (depende de Zoom).
- IFAPA Andalucía (no implementado).

Si preguntan: roadmap honesto + fecha tentativa.
