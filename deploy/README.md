# Plantillas de despliegue de Didacta

Plantillas para instalar Didacta Community en las plataformas de autoalojado de
un clic: **Coolify**, **Dokploy** y **Easypanel**.

No hay un formato común: cada plataforma tiene el suyo, su repositorio de
plantillas y su proceso de revisión. Estas carpetas son la copia de referencia
que vive en este repositorio; los ficheros se copian tal cual al repositorio de
cada plataforma cuando se manda el PR.

```
deploy/
├── assets/      iconos listos para las tres plataformas
├── coolify/     docker-compose.yaml con los metadatos en la cabecera
├── dokploy/     docker-compose.yml + template.toml + meta.json
└── easypanel/   index.ts + meta.yaml (+ un JSON para probar sin la plantilla)
```

## Lo que las tres plantillas hacen igual

- **Un solo dominio.** El contenedor corre la API (`:4000`) y la web (`:3000`)
  juntas, y Next.js reescribe `/api/*`, `/healthz` y `/readyz` al 4000 interno
  ([apps/web/next.config.mjs](../apps/web/next.config.mjs)). Solo se publica el
  3000: ni segundo dominio, ni CORS, ni cookies cruzadas.
- **Postgres con pgvector.** No es opcional. La migración baseline hace
  `CREATE EXTENSION "vector"`, así que un `postgres:16` estándar —lo que las
  tres plataformas ofrecen por defecto— revienta en el primer arranque. Las
  plantillas fuerzan `pgvector/pgvector:pg16`.
- **Sin `DATABASE_URL`.** Se define solo `ADMIN_DATABASE_URL` (el superusuario
  del Postgres del propio despliegue). El entrypoint aplica migraciones, RLS y
  grants con esa conexión y **deriva** la de runtime hacia el rol `didacta_app`
  (`NOBYPASSRLS`), que es lo que hace real el aislamiento entre tenants.
  Definir `DATABASE_URL` a mano degrada ese aislamiento y la app lo avisa por
  log.
- **`TENANT_SETTINGS_ENC_KEY` sin definir.** La app genera una clave hex de 32
  bytes en el primer arranque y la persiste en el volumen de datos. Fijarla
  desde la plantilla con un generador que no produzca exactamente 64 caracteres
  hexadecimales rompería el cifrado de secretos (SSO, SMTP por tenant, Stripe)
  y no se notaría hasta usar esas features. Por eso el volumen de datos tiene
  que ser escribible: en producción, si la clave no está definida y el fichero
  no se puede leer ni crear, la API no arranca (antes seguía con una clave en
  memoria que se perdía al reiniciar).
- **`DIDACTA_SETUP_TOKEN` fijado por la plantilla.** El alta de la primera
  cuenta va protegida por un token de un solo uso que, por defecto, solo sale
  por los logs del contenedor. Las plantillas lo generan con el helper de cada
  plataforma para poder enseñar el enlace ya montado:
  `https://<dominio>/setup?token=<valor>`.
- **Sin SMTP configurado.** La instalación arranca igual y avisa por la
  interfaz; los correos (verificación, invitaciones, recordatorios) no salen
  hasta rellenar las `SMTP_*`.
- **Un volumen que respaldar**: `/app/data` — uploads de cursos, certificados,
  evidencias y la clave de cifrado autogenerada.

## Coolify

`coolify/docker-compose.yaml` está en el formato de `templates/compose/*.yaml`
del repositorio [coollabsio/coolify](https://github.com/coollabsio/coolify): el
bloque de comentarios de la cabecera son los metadatos de la tarjeta del
servicio, y los secretos usan las variables mágicas de Coolify
(`SERVICE_FQDN_*`, `SERVICE_PASSWORD_64_*`, `SERVICE_USER_*`).

Sin esperar al PR: **+ New Resource → Docker Compose Empty**, pegar el fichero
entero y desplegar. Es el mismo camino que usa Coolify para probar plantillas
antes de aceptarlas.

Para el PR: copiar el fichero a `templates/compose/didacta.yaml` y el logo a
`public/svgs/didacta.svg`. Los PRs de servicios nuevos van contra **`next`**, no
contra `main`.

Dos cosas de ese fichero que parecen descuidos y no lo son:

- **Apenas lleva comentarios, y en inglés.** El control de calidad automático de
  Coolify (`peakoss/anti-slop`) cierra el PR si el diff añade más de 10 líneas
  de comentario, y seis se van en los metadatos de la cabecera. Lo que explicaba
  el fichero está aquí arriba, en «Lo que las tres plantillas hacen igual».
- **No declara la sección `volumes:`.** Ninguna plantilla oficial de Coolify lo
  hace: los volúmenes con nombre los crea el propio Coolify al desplegar. Como
  efecto secundario, `docker compose config` sobre este fichero suelto da
  «undefined volume» — es esperado, no es un fallo. Para probarlo fuera de
  Coolify, usa el de `dokploy/`, que sí es un compose autónomo.

## Dokploy

`dokploy/` es un blueprint completo de
[Dokploy/templates](https://github.com/Dokploy/templates) (rama `canary`):
basta copiar la carpeta a `blueprints/didacta/`, renombrar el icono a
`logo.svg` y ejecutar su validador:

```bash
node build-scripts/generate-meta.js --check
```

Reglas de esa casa que el compose ya cumple: sin `ports:`, sin
`container_name:`, sin `networks:`, `restart` en todos los servicios y el
nombre del servicio principal igual que el id del blueprint.

Sin esperar al PR: Dokploy acepta un **BASE URL propio** de plantillas al crear
un servicio compose, además del import por base64 desde la preview del PR.

## Easypanel

Easypanel **no despliega docker-compose**: la plantilla es una función
TypeScript que devuelve servicios nativos del panel. `easypanel/index.ts`
declara tres — la app, un Postgres con la imagen de pgvector y un Redis — y
`meta.yaml` describe la ficha y el formulario.

Para el PR en [easypanel-io/templates](https://github.com/easypanel-io/templates):
copiar la carpeta tal cual a `templates/didacta/` y ejecutar `npm run build` y
`npm run prettier`. `meta.ts` lo genera el repositorio; no se escribe a mano.

**El logo y las capturas van en `assets/`, no en la raíz de la plantilla.** Su
README dice «use these files: logo.png, screenshot.png» sin más, pero
`scripts/build-templates.ts` los busca en `templates/<slug>/assets/`: puestos en
la raíz, el build no falla — la ficha simplemente sale sin logo y sin captura.
Por eso esta carpeta ya tiene la estructura final.

Sin esperar al PR: `easypanel/didacta.json` es la salida de `index.ts` con los
valores por defecto, lista para **Create from JSON**. Antes de pegarla hay que
sustituir los tres marcadores `REEMPLAZA_*` por cadenas aleatorias distintas
(`openssl rand -hex 32`).

## Iconos

`assets/` lleva el isotipo cuadrado, que es lo que piden los tres catálogos
(icono, no logotipo con texto):

| Fichero                | Uso                                                       |
| ---------------------- | --------------------------------------------------------- |
| `didacta.svg`          | Coolify (`public/svgs/didacta.svg`), Dokploy (`logo.svg`) |
| `didacta-icon-128.png` | Easypanel — ya copiado en `easypanel/assets/logo.png`     |
| `didacta-icon-512.png` | fuente para recortes futuros                              |

`didacta.svg` es el SVG de marca con el isotipo recortado y el PNG interno
reescalado a 256 px: pasa de 281 KB a 32 KB sin cambiar cómo se ve. Sigue
siendo un raster envuelto en SVG, así que **al ampliarlo se pixela**; el día
que exista el isotipo con trazados vectoriales de verdad, se sustituye este
fichero y las tres plantillas lo heredan sin tocar nada más.

## Mantener esto vivo

Cada release de Didacta obliga a tocar la versión en **seis sitios de estas
plantillas**, y el `meta.json` de Dokploy exige además que coincida con el tag
de la imagen. `bash scripts/dev-check.sh --deploy` falla si alguno se queda
atrás:

| Fichero                       | Qué actualizar                           |
| ----------------------------- | ---------------------------------------- |
| `coolify/docker-compose.yaml` | tag de `image:` y `DIDACTA_CORE_VERSION` |
| `dokploy/docker-compose.yml`  | tag de `image:`                          |
| `dokploy/template.toml`       | `DIDACTA_CORE_VERSION`                   |
| `dokploy/meta.json`           | `version`                                |
| `easypanel/meta.yaml`         | default de `appServiceImage`             |
| `easypanel/didacta.json`      | imagen y `DIDACTA_CORE_VERSION`          |

Una plantilla que apunte a una imagen que todavía no existe en el registro deja
la instalación en «manifest unknown», así que estos bumps van **después** de que
la release esté publicada y verificada.
