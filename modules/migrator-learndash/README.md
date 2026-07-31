# mod.migrator-learndash

> Migrador completo desde **WordPress + LearnDash** hacia **Didacta**.
> Wizard didáctico paso a paso, ETL con staging, idempotencia por
> checksum, reportes auditables firmados.

| Campo             | Valor                                            |
| ----------------- | ------------------------------------------------ |
| Nombre            | `mod.migrator-learndash`                         |
| Edición           | **Community**                                    |
| Versión           | 1.0.0                                            |
| Categoría         | migration                                        |
| Estado            | Beta                                             |
| Core requerido    | `^1.0.0`                                         |
| Prefijo de tablas | `mod_migrator_learndash_*`                       |
| API namespace     | `/modules/migrator-learndash`                    |
| Entrega           | ZIP firmado (`mod.migrator-learndash-1.0.0.zip`) |

---

## Edición

**Community**. Como todos los módulos de Didacta, no se gatea por
licencia: las capabilities Enterprise son exclusivamente transversales
del core (ver `packages/license-sdk/src/capabilities.ts`).

## Estado

**Beta** — preparado para clientes piloto. Cubre el MVP del informe
analítico (`docs/migration_learndash.md`): contenido + usuarios + grupos

- inscripciones + media + progreso actual. Histórico fino de intentos
  y certificados emitidos quedan para Fase 2.

## Resumen funcional

Permite que un administrador **no técnico** migre toda su academia
LearnDash a Didacta en una hora, con un wizard guiado de 6 pasos:

1. **Bienvenida** — explicación + checklist de requisitos.
2. **Conectar** — URL del WordPress + Application Password.
3. **Resumen del origen** — conteos por entidad y avisos detectados.
4. **Opciones** — qué migrar, cómo tratar contraseñas, modelo de grupos.
5. **Comprobación previa (dry-run)** — prueba SIN tocar Didacta.
6. **Migración real** — progreso en tiempo real + reporte descargable.

Detrás del wizard, un **pipeline ETL** con staging, mapeo idempotente,
DLQ para errores de datos, reportes de reconciliación y cadena de
auditoría SHA-256 verificable.

## Modelo de datos (resumen)

13 tablas con prefijo `mod_migrator_learndash_*`:

- `_jobs` — un job por intento de migración (estado, progreso, options).
- `_mappings` — `source_id ↔ target_id` por entidad.
- `_dlq` — Dead Letter Queue (filas que fallaron sin abortar el job).
- `_audit_events` — bitácora append-only con cadena SHA-256.
- `_validation_reports` — un reporte por entidad con counts y muestras.
- `_stg_users`, `_stg_courses`, `_stg_lessons`, `_stg_topics`,
  `_stg_quizzes`, `_stg_questions`, `_stg_groups`, `_stg_enrollments`,
  `_stg_progress`, `_stg_media` — staging crudo + canónico tras
  transform.

Todas con `tenant_id` (RLS strict). **Cero FKs cross-module** —
las relaciones a `mod_courses`, `mod_users`, etc. se resuelven en la
fase load contra las APIs públicas de los módulos destino.

Ver detalle en `prisma/schema.prisma`.

## API pública

| Método | Path                       | Permiso                              | Función                                                                           |
| ------ | -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `POST` | `/preflight`               | `migrator-learndash.import.create`   | Valida credenciales y devuelve conteos.                                           |
| `POST` | `/jobs`                    | `migrator-learndash.import.create`   | Crea un job y lo lanza en background.                                             |
| `GET`  | `/jobs/:id`                | `migrator-learndash.import.read`     | Estado del job.                                                                   |
| `GET`  | `/jobs/:id/progress` (SSE) | `migrator-learndash.import.read`     | Stream de eventos de progreso.                                                    |
| `POST` | `/jobs/:id/cancel`         | `migrator-learndash.import.cancel`   | Cancela el job en curso.                                                          |
| `POST` | `/jobs/:id/rollback`       | `migrator-learndash.import.rollback` | **Beta** — revierte un job completado. No usar en prod sin validar (ver runbook). |
| `GET`  | `/jobs/:id/report`         | `migrator-learndash.report.read`     | Reporte (JSON / `?format=csv`).                                                   |
| `GET`  | `/jobs/:id/report.pdf`     | `migrator-learndash.report.export`   | Reporte firmado para auditor.                                                     |

Todos los endpoints respetan el namespace global del host
(`/api/v1/modules/migrator-learndash/...`).

## Eventos emitidos

Ninguno por ahora. El host todavía no expone un cliente de emisión de
eventos (`ctx.events`) a los módulos sandbox, así que el manifest declara
`eventsEmitted: []`. Cuando exista esa infraestructura se volverán a
declarar los eventos del ciclo de migración
(`import.started`/`completed`/`failed`/`cancelled`/`rollback.*`).

No consume eventos de otros módulos (es un consumidor unidireccional
del origen LearnDash).

## Dependencias

Módulos requeridos en el host:

- `mod.courses` — destino de cursos.
- `mod.learning` — destino de lecciones, temas y progreso.
- `mod.assessments` — destino de quizzes y preguntas.

Opcionales:

- `mod.certificates` — si se quieren migrar certificados emitidos
  (Fase 2).
- `mod.community` — si los grupos LearnDash se modelan como
  comunidades en lugar de cohortes.

Si alguno de los **requeridos** no está instalado, el módulo se carga
pero el wizard muestra un alert claro y bloquea el inicio del job
hasta que se instalen.

## Configuración (env)

El módulo NO requiere variables de entorno propias. Toma toda su
configuración del job (la pasa el wizard al crear cada migración).

## Licencia

Módulo **Community**: se instala en cualquier edición sin capability de
licencia. La lista cerrada de 11 capabilities Enterprise cubre solo
features transversales del core; gatear un módulo por licencia queda
fuera del alcance de `LICENSE_EE`.

## Cómo se entrega

Como **ZIP firmado** (`mod.migrator-learndash-1.0.0.zip`) con esta
estructura:

```
mod.migrator-learndash-1.0.0.zip
├── manifest.jwt              # JWS compact ES256 firmado por Didacta KMS
├── package.json              # name, version, main: dist/index.js
├── dist/                     # bundle CommonJS compilado
│   ├── index.js
│   ├── connector/
│   ├── mappers/
│   ├── etl/
│   └── api/
└── prisma/
    └── migrations/
        └── 20260503000000_init/
            └── migration.sql
```

### Para empaquetarlo:

```bash
cd modules/migrator-learndash
pnpm build
node ../../scripts/package-module.mjs --module migrator-learndash --version 1.0.0
# → dist/mod.migrator-learndash-1.0.0.zip
```

En modo desarrollo, la firma se hace con clave efímera (sufijo `-dev`).
Para producción se usa `aws kms sign` sobre `alias/didacta-issuer-2026`
(ver skill `package-module`).

### Para instalarlo en una instancia de Didacta:

1. Super admin entra a `/admin/marketplace`.
2. Drag&drop del `.zip`.
3. El backend valida firma, aplica migrations Prisma en transacción,
   carga el módulo en VM aislada, registra rutas en el dispatcher
   runtime → status `INSTALLED`.
4. Tenant admin activa el módulo desde `/admin/modules`.

## Runbook de migración (para el operador)

### Antes de empezar

1. Backup completo de la instancia Didacta destino. La migración es
   reversible (ver "Rollback") pero un backup es la red de seguridad.
2. Comprobar que los módulos `mod.courses`, `mod.learning` y
   `mod.assessments` están instalados y activos en el tenant.
3. Crear un Application Password en el WordPress origen:
   `Usuarios → Tu perfil → Application Passwords` → "didacta-migration"
   → copiar el password generado (formato `xxxx XXXX xxxx XXXX`).

### Durante la migración

- Si el wizard muestra "credenciales no son correctas", verificar que
  el password copiado es el Application Password (no el de login).
- Si el preflight tarda > 60s, suele indicar latencia alta del origen
  (no detiene la migración).
- Si una entidad concreta entra repetidamente a la DLQ con el mismo
  errorCode, es un problema sistemático del origen — pausar y
  contactar soporte.

### Si algo va mal

- **Cancelación**: pulsar "Cancelar" en el wizard. Lo cargado hasta
  ese punto se queda; el resto no se carga. El origen no se ha tocado.
- **Recovery / rollback**: el módulo **NO** tiene rollback automático
  validado para producción. El único path soportado es restore desde
  un `pg_dump` pre-migración; si no se puede tirar el progreso
  posterior al backup, la alternativa es el borrado quirúrgico
  (`DELETE ... WHERE external_source='learndash'`) tabla a tabla,
  siempre dentro de una transacción y con dump previo.

  > El endpoint `POST /jobs/:id/rollback` existe pero está marcado
  > como **Beta** y no se ha validado contra volúmenes reales
  > (>1k users). NO usarlo en producción sin pruebas previas.

### Tras la migración

- Descargar el reporte CSV (`GET /jobs/:id/report?format=csv`).
- Descargar el reporte PDF firmado para auditor.
- Verificar la cadena de auditoría: `GET /jobs/:id/audit/verify`
  debe responder `verified: true`.
- Comunicar a los usuarios migrados que recibirán email de
  activación (default `password_strategy=activation_reset`).

## FAQ para usuario no técnico

**¿Puedo cerrar el navegador durante la migración?**
Sí. El job corre en backend. Cuando vuelvas a abrir el wizard, te
llevará directamente al paso de "Migrando..." con el progreso
actualizado.

**¿Y si no termina?**
Cada job tiene timeout por defecto de 6 horas. Si supera ese tiempo,
se marca `failed` y se puede relanzar como nuevo job (idempotente:
no duplicará lo ya cargado).

**¿Pierde algo del origen?**
No. El migrador SOLO LEE del origen, nunca escribe ni borra. Tu
WordPress + LearnDash queda intacto.

**¿Y los hashes de contraseñas?**
Por defecto NO se importan (estrategia `activation_reset`): cada
usuario migrado recibe un email de bienvenida con link para
establecer su contraseña en Didacta. Es la opción más segura porque
los hashes WordPress (PHPass) no son compatibles con el estándar
moderno de Didacta (Argon2id).

**¿Qué pasa con el progreso de los alumnos?**
Se migra el estado actual (curso completado / en progreso / no
iniciado). El histórico fino de intentos de quiz NO se migra en MVP
— se perdería la trazabilidad de cada intento individual. Si lo
necesitas, contacta soporte (Fase 2).

**¿Y los certificados ya emitidos?**
En MVP solo se migran las **plantillas** de certificado. Los
certificados ya emitidos a alumnos se vuelven a generar al primer
acceso a Didacta (con la nueva plantilla). La fecha original de
emisión se conserva como metadata.

**¿Cuánto tarda?**
Depende del tamaño:

| Volumen                    | Tiempo aprox. |
| -------------------------- | ------------- |
| 100 alumnos, 10 cursos     | < 5 min       |
| 1.000 alumnos, 50 cursos   | 15-30 min     |
| 10.000 alumnos, 200 cursos | 1-2 h         |

## Soporte

Para incidencias:

1. Descarga el reporte JSON del job (incluye errorCodes tipados).
2. Descarga el log de auditoría (`GET /jobs/:id/audit/export.json`).
3. Abre ticket en `https://didacta.io/support` adjuntando ambos.

## Licencia

Este módulo se distribuye bajo licencia propietaria Didacta para
clientes con plan Enterprise. Ver `LICENSE_NOTICE.md` del repo root.
