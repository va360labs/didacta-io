# Migration runbook — va360.academy → Didacta

> Runbook operativo paso a paso para la migración productiva desde
> **WordPress + LearnDash** (origen: `va360.academy`) hacia una
> instancia de Didacta. Copy-pasta los comandos en orden — no requiere
> pensar entre pasos.
>
> Operador: Valen (`valen@va360labs.com`).
> Audiencia: cualquier ingeniero de turno que necesite ejecutar la
> migración o recuperarla si algo falla.

---

## Convenciones

- Sustituí los placeholders `<...>` por valores reales antes de pegar.
- Los comandos asumen `bash` (Linux/macOS o `WSL`/`Git Bash` en
  Windows). Para PowerShell puro, ver notas al final.
- Todos los endpoints HTTP del módulo van bajo
  `${DIDACTA_URL}/api/v1/modules/migrator-learndash/...`.
- El token de admin se obtiene con `POST /api/v1/auth/login` y se
  exporta como `$ADMIN_TOKEN` para todos los comandos siguientes.

---

## Pre-flight checklist (30 min)

- [ ] **Backup del PG del tenant destino** (red de seguridad):
  ```bash
  pg_dump -Fc -d didacta_prod -f "pre-migration-$(date +%F).dump"
  # Verificar que el archivo existe y pesa > 0 bytes
  ls -lh pre-migration-*.dump
  ```

- [ ] **SMTP del tenant destino configurado Y verificado**:

  1. Configurar SMTP (ajustar host/puerto/credenciales reales):
  ```bash
  curl -X PUT "${DIDACTA_URL}/api/v1/admin/tenant-settings/smtp" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "host": "smtp.sendgrid.net",
      "port": 587,
      "secure": false,
      "user": "apikey",
      "pass": "<SENDGRID_API_KEY>",
      "fromEmail": "no-reply@va360.academy",
      "fromName": "Didacta — VA360"
    }'
  # Esperado: 200 OK + { "ok": true }
  ```

  2. Mandar un email de test al operador y comprobar bandeja:
  ```bash
  curl -X POST "${DIDACTA_URL}/api/v1/admin/tenant-settings/smtp/test" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{ "to": "valen@va360labs.com" }'
  # Esperado: 200 OK + { "ok": true, "messageId": "..." }
  # NO continuar hasta tener el email en la bandeja.
  ```

- [ ] **Capacidad `feat:migrators.learndash` activa en el tenant**:
  ```bash
  curl -s "${DIDACTA_URL}/api/v1/admin/license" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq '.capabilities[] | select(. == "feat:migrators.learndash")'
  # Esperado: "feat:migrators.learndash" (cualquier otra cosa = falta capability)
  ```

- [ ] **Módulo `mod.migrator-learndash@1.0.33` (o superior) instalado**:
  ```bash
  curl -s "${DIDACTA_URL}/api/v1/admin/modules/installed" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq '.modules[] | select(.slug == "migrator-learndash") | { slug, version, status }'
  # Esperado: { "slug": "migrator-learndash", "version": "1.0.33" o mayor, "status": "ACTIVE" }
  ```

- [ ] **Host versión `≥0.0.1-alpha.75`**:
  ```bash
  curl -s "${DIDACTA_URL}/healthz" | jq '.version'
  # Esperado: "0.0.1-alpha.75" o superior (comparación semver)
  ```

- [ ] **WordPress origen accesible con Application Password**:
  ```bash
  curl -u "${WP_USERNAME}:${WP_APP_PASSWORD}" \
    "${WP_BASE_URL}/wp-json/wp/v2/users?per_page=1"
  # Esperado: array JSON con 1 user. 401 = credenciales mal.
  ```

- [ ] **Application Password de WP creado**:
  - En el WP origen: `Usuarios → Tu perfil → Application Passwords`
  - Nombre: `didacta-migration-prod`
  - Botón "Add New Application Password"
  - Copiar el password generado (formato `xxxx XXXX xxxx XXXX`,
    cuatro grupos separados por espacio). Solo se muestra UNA VEZ.
  - Guardarlo en el `.env` como `WP_APP_PASSWORD` (los espacios
    son parte del password — entre comillas dobles).

- [ ] **Variables de entorno preparadas en `.env`** (copy-paste y
  rellenar):
  ```bash
  # .env (no commitear)
  DIDACTA_URL=https://didacta.va360labs.com
  DIDACTA_ADMIN_EMAIL=valen@va360labs.com
  DIDACTA_ADMIN_PASSWORD=<password-admin-didacta>

  WP_BASE_URL=https://va360.academy
  WP_USERNAME=valen
  WP_APP_PASSWORD="xxxx XXXX xxxx XXXX"
  ```

  Cargar en la shell actual:
  ```bash
  set -a; source .env; set +a
  ```

- [ ] **Obtener `ADMIN_TOKEN` del tenant destino**:
  ```bash
  export ADMIN_TOKEN=$(curl -s -X POST "${DIDACTA_URL}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${DIDACTA_ADMIN_EMAIL}\",\"password\":\"${DIDACTA_ADMIN_PASSWORD}\"}" \
    | jq -r '.accessToken')
  # Verificar:
  echo "${ADMIN_TOKEN}" | cut -c1-20
  # Esperado: una cadena tipo "eyJhbGciOiJSUzI1NiIs..." (no vacío)
  ```

---

## Migración (estimación: 30 min)

### 1. Lanzar el job FULL

```bash
JOB_RESPONSE=$(curl -s -X POST \
  "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"mode\": \"full\",
    \"source\": {
      \"baseUrl\": \"${WP_BASE_URL}\",
      \"username\": \"${WP_USERNAME}\",
      \"applicationPassword\": \"${WP_APP_PASSWORD}\"
    },
    \"options\": {
      \"migrateContent\": true,
      \"migrateUsers\": true,
      \"migrateGroups\": true,
      \"migrateEnrollments\": true,
      \"migrateMedia\": true,
      \"migrateProgress\": true,
      \"passwordStrategy\": \"activation_reset\",
      \"groupsAs\": \"cohorts\"
    }
  }")

export JOB_ID=$(echo "${JOB_RESPONSE}" | jq -r '.id')
echo "JOB_ID=${JOB_ID}"
# Guardalo. Te va a hacer falta en todos los pasos siguientes.
```

### 2. Esperar terminación (watch loop con timeout de 30 min)

```bash
TIMEOUT=1800  # 30 min en segundos
START=$(date +%s)
while true; do
  STATUS=$(curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq -r '.status')
  PROGRESS=$(curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq -r '.progress.percent // 0')

  echo "[$(date +%T)] status=${STATUS} progress=${PROGRESS}%"

  if [ "${STATUS}" = "completed" ] || [ "${STATUS}" = "failed" ] || [ "${STATUS}" = "cancelled" ]; then
    echo "Final status: ${STATUS}"
    break
  fi

  ELAPSED=$(( $(date +%s) - START ))
  if [ ${ELAPSED} -gt ${TIMEOUT} ]; then
    echo "ABORTING: timeout 30 min superado"
    break
  fi

  sleep 15
done
```

Si el status final NO es `completed`, ir a **FAQ / troubleshooting**
antes de continuar.

### 3. Verificar el report

```bash
curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}/report" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq '{
      courses: .entities.courses,
      users: .entities.users,
      lessons: .entities.lessons,
      topics: .entities.topics,
      enrollments: .entities.enrollments,
      failRate: (.entities | to_entries | map({k: .key, fr: (.value.failed / (.value.total // 1))}))
    }'
```

Esperado (orden de magnitud para va360.academy):

| Entidad     | Total esperado |
|-------------|----------------|
| courses     | 13             |
| users       | ~2.900         |
| lessons     | ~120           |
| topics      | ~400           |
| enrollments | ~5.000         |

**REGLA DE ABORTO**: si `failRate > 0.05` (5%) en cualquier entidad,
NO continuar. Descargar el reporte CSV completo, abrir ticket interno
y diagnosticar antes de seguir:

```bash
curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}/report?format=csv" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -o "report-${JOB_ID}.csv"
```

### 4. Sincronizar enrollments (post-migration)

El módulo migra los `_stg_enrollments` a su staging, pero la creación
de los enrollments reales en `mod_learning_enrollment` la hace un
script post-migración que cruza staging del migrador con la base de
usuarios y cursos ya cargados.

```bash
cd D:/Test/didacta-community
tsx scripts/post-migration/sync-enrollments-from-learndash.ts \
  --job-id "${JOB_ID}" \
  --tenant "$(curl -s "${DIDACTA_URL}/api/v1/auth/whoami" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" | jq -r '.tenantId')"
```

Esperado: summary final tipo

```json
{
  "totalUsersScanned": 2900,
  "totalCoursesScanned": 13,
  "totalEnrollmentsCreated": 4870,
  "totalEnrollmentsSkipped": 30,
  "totalUsersMissingInDidacta": 0
}
```

**Si `totalEnrollmentsCreated == 0`**: algo está mal, ir a FAQ
("El script de enrollments dice 'user wpId=X no migrado'").

### 5. Publicar cursos

Tras la migración los 13 cursos quedan en `DRAFT`. Publicarlos uno a
uno (loop bash):

```bash
COURSE_IDS=$(curl -s "${DIDACTA_URL}/api/v1/courses?status=DRAFT&externalSource=learndash&pageSize=100" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.items[].id')

for id in ${COURSE_IDS}; do
  echo "Publicando ${id}..."
  curl -s -X POST "${DIDACTA_URL}/api/v1/courses/${id}/publish" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq '{ id: .id, status: .status }'
  sleep 1
done
```

Esperado: 13 cursos con `status: "PUBLISHED"`.

### 6. Enviar emails de activación

Si el job se lanzó con `passwordStrategy: activation_reset` (default
y recomendado), todos los usuarios migrados quedan en estado
`PENDING`. Hay que dispararles el email de activación.

```bash
USER_IDS=$(curl -s "${DIDACTA_URL}/api/v1/admin/users?status=PENDING&externalSource=learndash&pageSize=5000" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.items[].id')

TOTAL=$(echo "${USER_IDS}" | wc -l)
echo "Voy a mandar ${TOTAL} emails de activación a 1 req/s (~$((TOTAL/60)) min)"

i=0
for uid in ${USER_IDS}; do
  i=$((i+1))
  curl -s -X POST "${DIDACTA_URL}/api/v1/admin/users/${uid}/resend-invite" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -o /dev/null -w "[${i}/${TOTAL}] %{http_code}\n"
  sleep 1
done
```

Throttle de 1 req/s para no saturar el SMTP. Si tu provider permite
más (SendGrid soporta ~100 req/s), bajar el `sleep` — pero 1 req/s
es el seguro.

Esperado: 2900 emails enviados en ~50 min, todas las respuestas con
HTTP 200 o 204.

---

## Verificación post-migración (10 min)

### Queries SQL contra el PG destino

```sql
-- 1. Usuarios migrados (debe coincidir con conteo del origen WP)
SELECT COUNT(*) AS users_migrated
FROM "user"
WHERE external_source = 'learndash';
-- Esperado: ~2900 (= users en va360.academy)

-- 2. Enrollments migrados (≈ enrollments LearnDash en origen)
SELECT COUNT(*) AS enrollments_migrated
FROM mod_learning_enrollment
WHERE external_source = 'learndash';
-- Esperado: ~5000 ±5%

-- 3. Cursos publicados
SELECT COUNT(*) AS published_courses
FROM mod_courses_course
WHERE external_source = 'learndash'
  AND status = 'PUBLISHED';
-- Esperado: 13

-- 4. Lessons + topics
SELECT
  (SELECT COUNT(*) FROM mod_courses_lesson WHERE external_source='learndash') AS lessons,
  (SELECT COUNT(*) FROM mod_courses_module WHERE external_source='learndash') AS modules;
-- Esperado: lessons ~120, modules ~13 (1 module = 1 course en LD)

-- 5. DLQ — chequear nada quedó atascado
SELECT entity, error_code, COUNT(*)
FROM mod_migrator_learndash_dlq
WHERE job_id = '<JOB_ID>'
GROUP BY entity, error_code
ORDER BY COUNT(*) DESC;
-- Esperado: vacío o < 5% del total. Cualquier error_code repetido > 10 veces es señal de problema sistemático.
```

### Endpoints HTTP de verificación

```bash
# Stats globales del tenant
curl -s "${DIDACTA_URL}/api/v1/admin/stats" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq '{ activeUsers, coursesPublished, totalEnrollments }'
# Esperado: activeUsers ~2900, coursesPublished = 13

# Verificar cadena de auditoría del job
curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}/audit/verify" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"
# Esperado: { "verified": true, "events": N, "tampered": [] }
```

### Spot check manual en la UI

1. Login con un usuario operador (no admin) en `${DIDACTA_URL}`.
2. Ir al catálogo de cursos. Comprobar que aparecen los 13.
3. Abrir 2 cursos al azar y verificar:
   - Estructura de módulos/lecciones coincide con el origen.
   - Vídeos / imágenes embebidos cargan correctamente.
   - El editor de quiz muestra las preguntas migradas.
4. Pedir a 1 usuario real (no admin) que abra el email de activación
   recibido y complete el flujo de set-password. Debe poder entrar.

---

## Rollback (si algo sale mal)

> **Honestidad operativa**: el módulo `mod.migrator-learndash` NO
> tiene rollback automático en producción. El endpoint
> `POST /jobs/:id/rollback` existe pero está marcado como **Beta** y
> no se ha validado contra volúmenes reales (>1k users). NO usarlo
> en va360.academy sin pruebas previas.
>
> El **único** recovery soportado en producción es restore desde el
> `pg_dump` pre-migración.

### Opción A — Restore completo desde backup (recomendado)

```bash
# 1. Parar el host Didacta para que nadie escriba durante el restore
docker compose -f /opt/didacta/docker-compose.yml stop api web

# 2. Drop + recreate de la DB destino
dropdb -h <PG_HOST> -U <PG_USER> didacta_prod
createdb -h <PG_HOST> -U <PG_USER> didacta_prod

# 3. Restore del dump pre-migración
pg_restore \
  -h <PG_HOST> -U <PG_USER> \
  -d didacta_prod \
  --no-owner --no-acl \
  "pre-migration-YYYY-MM-DD.dump"

# 4. Levantar el host
docker compose -f /opt/didacta/docker-compose.yml start api web

# 5. Verificar
curl -s "${DIDACTA_URL}/healthz" | jq '.status'
# Esperado: "ok"
```

**Esto borra TODO progreso post-backup**. Si entre el backup y el
rollback hubo actividad real (usuarios creando contenido, alumnos
completando lecciones, pagos), esa actividad se PIERDE. No hay un
"deshacer solo la migración" en este path.

### Opción B — Borrar solo lo migrado por LearnDash (PELIGROSO)

Útil si entre el job y el rollback hubo actividad real que NO se
puede tirar. **Riesgo**: si un usuario migrado ya interactuó con el
sistema (login, completó una lección, etc.), borrar su row deja
huérfanos en otras tablas. Solo usar si entiendes el modelo de datos
y aceptás auditar a mano los huérfanos.

```sql
BEGIN;

-- Borrar enrollments primero (FKs a user + course)
DELETE FROM mod_learning_progress WHERE external_source='learndash';
DELETE FROM mod_learning_enrollment WHERE external_source='learndash';

-- Borrar contenido en orden inverso de dependencias
DELETE FROM mod_assessments_question WHERE external_source='learndash';
DELETE FROM mod_assessments_quiz WHERE external_source='learndash';
DELETE FROM mod_courses_lesson WHERE external_source='learndash';
DELETE FROM mod_courses_module WHERE external_source='learndash';
DELETE FROM mod_courses_course WHERE external_source='learndash';

-- Borrar usuarios migrados (solo si NUNCA hicieron login)
DELETE FROM "user"
WHERE external_source = 'learndash'
  AND last_login_at IS NULL;
-- Los que SÍ hicieron login: dejarlos, decidir caso por caso.

-- Limpiar staging del migrador
TRUNCATE TABLE mod_migrator_learndash_stg_users CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_courses CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_lessons CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_topics CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_quizzes CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_questions CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_groups CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_enrollments CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_progress CASCADE;
TRUNCATE TABLE mod_migrator_learndash_stg_media CASCADE;

-- Limpiar mapeos y DLQ del job
DELETE FROM mod_migrator_learndash_mappings WHERE job_id = '<JOB_ID>';
DELETE FROM mod_migrator_learndash_dlq WHERE job_id = '<JOB_ID>';

-- Marcar el job como rolled-back
UPDATE mod_migrator_learndash_jobs
SET status = 'rolled_back', finished_at = NOW()
WHERE id = '<JOB_ID>';

-- Revisar conteos antes de commit
SELECT COUNT(*) FROM "user" WHERE external_source='learndash';  -- esperado: 0 o solo los que hicieron login
SELECT COUNT(*) FROM mod_courses_course WHERE external_source='learndash';  -- esperado: 0

-- Si todo OK:
COMMIT;
-- Si dudas: ROLLBACK;
```

---

## FAQ / troubleshooting

### "El job se queda en 'extracting' eternamente"

**Causa probable**: WP origen está respondiendo lento (latencia alta
o rate-limited por un plugin de seguridad tipo Wordfence).

**Diagnóstico**:
```bash
# Ver últimos eventos del job
curl -s "${DIDACTA_URL}/api/v1/modules/migrator-learndash/jobs/${JOB_ID}/audit/export.json" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq '.events[-10:]'

# Probar manualmente el endpoint de WP que estaría llamando
time curl -u "${WP_USERNAME}:${WP_APP_PASSWORD}" \
  "${WP_BASE_URL}/wp-json/ldlms/v2/sfwd-courses?per_page=10"
# Si tarda > 5s, el origen es el cuello de botella.
```

**Fix**:
- Pedir al admin del WP origen que añada la IP del host Didacta a la
  allowlist de Wordfence / Cloudflare durante la ventana de migración.
- Si persiste, cancelar el job (`POST /jobs/${JOB_ID}/cancel`),
  esperar 5 min y relanzar — el módulo es idempotente, no duplicará.

### "SMTP test falló con XYZ"

| Error                                | Causa común                       | Fix                                       |
|--------------------------------------|-----------------------------------|-------------------------------------------|
| `ECONNREFUSED` / `ETIMEDOUT`         | Host/puerto mal o firewall        | Verificar host y `port: 587` (TLS) o 465  |
| `Invalid login: 535 Authentication`  | User/pass SMTP incorrectos        | Regenerar API key del provider            |
| `Greeting never received`            | `secure: true` con puerto 587     | Usar `secure: false` con 587 (STARTTLS)   |
| `Message rejected: 550 ...`          | `fromEmail` no autorizado         | Verificar dominio SPF/DKIM en el provider |

### "Algún user no se migró"

Ver la DLQ del job para encontrar el motivo exacto:

```sql
SELECT entity, source_id, error_code, error_message, payload
FROM mod_migrator_learndash_dlq
WHERE job_id = '<JOB_ID>'
  AND entity = 'user'
ORDER BY created_at DESC
LIMIT 50;
```

Errores típicos:
- `INVALID_EMAIL` → el WP origen tenía un email con formato mal. No
  hay fix automático: pedir al cliente que corrija el email en WP y
  relanzar el job (modo incremental).
- `EMAIL_ALREADY_EXISTS` → un usuario con ese email ya existe en
  Didacta (alta manual previa). Decisión del cliente: ¿merge o skip?

### "El script de enrollments dice 'user wpId=X no migrado'"

**Significa**: el user en `va360.academy` con `wp_user_id=X` no está
en la tabla `_stg_users` del job actual, así que tampoco está en
`mod_users` con `external_source='learndash'`. El script no puede
crearle el enrollment.

**Causas posibles**:

1. El user fue creado en WP DESPUÉS del extract del migrador.
   - **Fix**: relanzar job en modo `incremental` para sincronizar
     usuarios nuevos. Después volver a correr el script de enrollments.

2. El user fue filtrado por el `passwordStrategy` o por algún
   `options.userFilter` (si se aplicó uno custom).
   - **Fix**: revisar `report.users.skipped` con el motivo.

3. El user existía en Didacta con otro `external_source` (p.ej. un
   admin creado manualmente).
   - **Fix**: si querés que reciba enrollments, actualizar manualmente
     el `external_id` del row para que coincida con el `wpId`. O
     skipear ese user del enrollment (el script tiene flag
     `--skip-missing-users`).

### "Los cursos están en DRAFT y no quiero publicarlos todos"

Es esperado y por diseño. El módulo NO publica automáticamente —
deja al operador decidir cuándo y cuáles. Si querés publicar solo
algunos, sustituí el loop del paso 5 por publicaciones individuales:

```bash
curl -X POST "${DIDACTA_URL}/api/v1/courses/<COURSE_ID>/publish" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"
```

Los que queden en `DRAFT` son invisibles para los alumnos hasta que
se publiquen.

---

## Apéndice: notas para PowerShell puro

Si estás en Windows sin WSL/Git Bash, los loops y `jq` no funcionan
directamente. Equivalencias rápidas:

```powershell
# Variables de entorno
$env:DIDACTA_URL = "https://didacta.va360labs.com"
$env:WP_APP_PASSWORD = "xxxx XXXX xxxx XXXX"

# Login y captura de token
$resp = Invoke-RestMethod -Method Post `
  -Uri "$env:DIDACTA_URL/api/v1/auth/login" `
  -ContentType "application/json" `
  -Body (@{ email=$env:DIDACTA_ADMIN_EMAIL; password=$env:DIDACTA_ADMIN_PASSWORD } | ConvertTo-Json)
$env:ADMIN_TOKEN = $resp.accessToken

# Lanzar job
$jobBody = @{
  mode = "full"
  source = @{ baseUrl=$env:WP_BASE_URL; username=$env:WP_USERNAME; applicationPassword=$env:WP_APP_PASSWORD }
  options = @{ migrateContent=$true; migrateUsers=$true; migrateEnrollments=$true; passwordStrategy="activation_reset" }
} | ConvertTo-Json -Depth 5

$job = Invoke-RestMethod -Method Post `
  -Uri "$env:DIDACTA_URL/api/v1/modules/migrator-learndash/jobs" `
  -Headers @{ Authorization="Bearer $env:ADMIN_TOKEN" } `
  -ContentType "application/json" -Body $jobBody
$env:JOB_ID = $job.id
```

Para el resto (queries SQL, `pg_dump`/`pg_restore`) usá las mismas
herramientas — son cross-platform.
