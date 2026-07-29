# mod.gamification — Puntos, niveles y retos

## Edición

Community. Como todos los módulos del repo, no lleva ficheros `.ee.*` (el vallado de EE los prohíbe fuera del core).

## Estado

v1.0.0 — implementado. Sustituye al ranking anterior, que vivía en un controller del host y recalculaba los puntos en cada consulta sin guardar nada.

## Resumen funcional

Convierte la actividad de la comunidad en un libro de puntos auditable. Dos capas deliberadamente distintas:

- **Actividad** — asientos automáticos disparados por eventos que ya circulaban por el bus, con pesos bajos y techo diario. Premian constancia, no volumen.
- **Hitos** — retos con prueba obligatoria y revisión humana, con pesos altos. Es donde vive la intención de negocio: el primero que suele montarse es «documenta y publica tu caso de éxito».

Encima de las dos: los **niveles** se calculan sobre los puntos de por vida y no bajan nunca; la **clasificación** se calcula por rango de fechas y sí se mueve.

El catálogo lo define el operador desde `/admin/gamificacion`. Los niveles y los retos **nacen vacíos a propósito**: sus nombres y sus premios son decisiones de marca, no datos que pueda inventar el sistema. Lo único que se siembra en runtime son las reglas, con los pesos que ya usaba el ranking anterior (post 10, comentario 5) para que el traspaso no mueva a nadie de puesto.

## Modelo de datos

| Tabla                           | Para qué                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `mod_gamification_ledger_entry` | El asiento. Append-only salvo la revocación, que se marca sin borrar la fila. |
| `mod_gamification_profile`      | Saldo materializado por persona. No es la fuente de verdad: lo es el ledger.  |
| `mod_gamification_rule`         | Catálogo de reglas automáticas (puntos, techo diario, activa).                |
| `mod_gamification_level`        | Niveles del operador, con su beneficio.                                       |
| `mod_gamification_challenge`    | Retos con premio y ventana de fechas.                                         |
| `mod_gamification_submission`   | Entregas, una por reto y persona.                                             |

Dos claves sostienen la integridad:

- `@@unique([tenantId, userId, sourceKey])` en el ledger. La `sourceKey` identifica el **hecho** (`community.post:<id>`), no el evento. Es la única defensa real contra el doble cobro: el bus entrega _al menos una vez_ y su `idempotencyKey` lleva `Date.now()`, así que no deduplica aguas abajo.
- `@@unique([tenantId, challengeId, userId])` en las entregas, que corta el reenvío en bucle.

`occurredAt` guarda la fecha del hecho, separada de la de inserción, para que el relleno del histórico respete las fechas originales y los cortes por rango sigan dando lo mismo.

El aislamiento entre tenants lo da la política genérica de `rls.sql`, que cubre cualquier tabla con columna `tenant_id` y se reaplica en cada despliegue.

## API pública

Bajo `/api/v1/modules/gamification`. El interceptor de módulos la bloquea entera si el tenant desactiva el módulo.

**Miembro:** `GET /leaderboard`, `GET /me`, `GET /me/history`, `GET /levels`, `GET /challenges`, `POST /challenges/:id/submit`.

**Operador:** `GET|PUT /admin/rules`, `POST|PUT|DELETE /admin/levels`, `GET|POST|PUT|DELETE /admin/challenges`, `GET /admin/submissions`, `POST /admin/submissions/:id/review`, `POST /admin/backfill`.

El módulo nunca lee la tabla `user`: los nombres para mostrar los resuelve el controller del host, igual que hace mod.community con el autor de un post.

## Eventos

**Emite:** `gamification.points.awarded`, `gamification.points.revoked`, `gamification.level.changed`, `gamification.challenge.submitted`, `gamification.challenge.reviewed`.

**Consume** (vía `GamificationEventsBridge`, en el host): `community.post.created`, `community.comment.created`, `community.post.hidden`, `community.comment.hidden`, `resources.resource.created`, `resources.resource.deleted`, `learning.course.completed`, `referrals.referral.attributed`.

El bridge comprueba en cada evento si el módulo sigue activo para ese tenant. Hace falta porque desactivar un módulo **no** apaga el bus: las suscripciones se hacen una vez por proceso en `onRegister` y `onDisable` no desuscribe nada.

Se puntúa `referrals.referral.attributed` y no `commission.created` porque la comisión se devenga en cada factura recurrente y pagaría puntos todos los meses por el mismo referido.

## Configuración

Ninguna variable de entorno. Todo el comportamiento se configura por tenant desde `/admin/gamificacion`: pesos, techos diarios, activación de cada regla, niveles y retos.

`POST /admin/backfill` rellena el ledger con la actividad anterior. Es idempotente y se puede repetir. Excluye lo que el ranking viejo contaba por error: contenido oculto por moderación y posts publicados con API key. No aplica el techo diario, porque es una regla nueva y aplicarla hacia atrás castigaría a quien publicó cuando no existía.

## Dependencias

`@didacta/core-kernel` y `@didacta/database`.

Declara como opcionales `mod.community`, `mod.learning` y `mod.resources`: el relleno del histórico lee sus tablas filtrando por `tenant_id`, solo lectura y con la dependencia declarada, según ADR-016.
