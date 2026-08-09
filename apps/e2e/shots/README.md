<!--
Copyright (c) VA360 LABS S.L.
SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
-->

# Generador de capturas de la documentación

Las 40 capturas de los dos recorridos visuales de [`didacta-docs`](https://github.com/va360labs/didacta-docs)
se hacían **a mano**. Esto las genera solas, en español y en inglés, contra una
instalación real. Si mañana cambia la interfaz, se vuelve a lanzar.

| Recorrido                           | Capturas | Destino en `didacta-docs`                                   |
| ----------------------------------- | -------- | ----------------------------------------------------------- |
| `01-recorrido-visual.spec.ts`       | 22       | `docs/assets/recorrido-visual/` (es) · `.../en/` (en)       |
| `02-notificaciones-y-pagos.spec.ts` | 18       | `docs/assets/notificaciones-y-pagos/` (es) · `.../en/` (en) |

Los PNG **no se versionan en este repo**: caen en `apps/e2e/shots-output/`
(ignorado) y de ahí se copian al repo de documentación.

---

## Qué tiene que estar levantado

1. **Postgres** del stack (por defecto el contenedor `didacta-e2e-postgres` en
   `127.0.0.1:5442`, imagen `pgvector/pgvector:pg16`).
2. **API** compilada (`apps/api/dist/main.js`) — la arranca `reset-instance.sh`.
3. **Web** compilada y sirviendo en `:3010`:

   ```bash
   (cd apps/web && unset PORT && node ../../node_modules/next/dist/bin/next start -p 3010)
   ```

   ⚠️ `API_INTERNAL_URL` se hornea en el `next build`: si mueves la API de
   puerto hay que **reconstruir** la web, no basta con reexportar la variable.

4. **Mailpit** — lo crea `reset-instance.sh` (`didacta-shots-mailpit`,
   SMTP `:1027`, web `:8027`). La captura de la bandeja de entrada es su
   interfaz real: el correo de prueba se envía de verdad.
5. **Salida a internet**: una de las capturas llama a la API real de Stripe
   para retratar el error con el que rechaza una clave inválida.

## Cómo se lanza

```bash
source apps/e2e/shots/env.example.sh     # o tu propio env

# 1. Instancia virgen (cero tenants) + API reiniciada + Mailpit vacío.
#    Imprime el token de un solo uso del asistente de configuración.
bash apps/e2e/shots/reset-instance.sh
export SHOTS_SETUP_TOKEN='…'             # el que acaba de imprimir

# 2. Tanda española (40 capturas)
cd apps/e2e
SHOTS_LOCALE=es-ES node ../../node_modules/@playwright/test/cli.js \
  test --config playwright.shots.config.ts
```

Para la tanda inglesa hay que **volver a resetear**: el asistente de
configuración solo se completa una vez por instancia.

```bash
cd ../..
bash apps/e2e/shots/reset-instance.sh
export SHOTS_SETUP_TOKEN='…'
cd apps/e2e
SHOTS_LOCALE=en-US node ../../node_modules/@playwright/test/cli.js \
  test --config playwright.shots.config.ts
```

Cada tanda tarda **~35 s**. Al terminar:

```
apps/e2e/shots-output/
├── recorrido-visual/            22 PNG en español
│   └── en/                      22 PNG en inglés
└── notificaciones-y-pagos/      18 PNG en español
    └── en/                      18 PNG en inglés
```

Copiar a `didacta-docs/docs/assets/` respetando la misma estructura.

## Variables

Todas tienen default razonable; ver `env.example.sh`.

| Variable                                          | Para qué                                                      |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `SHOTS_LOCALE`                                    | `es-ES` (default) o `en-US`                                   |
| `SHOTS_OUT_DIR`                                   | Dónde caen los PNG (default `apps/e2e/shots-output/`)         |
| `SHOTS_BASE_URL`                                  | Web (default `http://localhost:3010`)                         |
| `SHOTS_API_URL`                                   | API; por defecto a través del rewrite de Next                 |
| `SHOTS_SETUP_TOKEN`                               | Token de un solo uso de `POST /setup/init`                    |
| `SHOTS_MAILPIT_URL` / `_SMTP_HOST` / `_SMTP_PORT` | Mailpit                                                       |
| `SHOTS_PG_CONTAINER` / `_PG_USER` / `_PG_DB`      | Para aplicar `seed.sql` tras crear el tenant                  |
| `WEB_PUBLIC_URL`                                  | **De la API.** El enlace del email de invitación sale de aquí |

## Decisiones que conviene conocer antes de tocar esto

**Viewport fijo 1440×900, `deviceScaleFactor: 1`.** Es el tamaño de las 40
capturas originales y lo que hace que la española y la inglesa se puedan
comparar píxel a píxel. `browser.newContext()` **no** hereda el bloque `use`
de la config: el viewport se pasa a mano en `lib/browser.ts`.

**El idioma se resuelve por el PERFIL, no solo por la cookie.** `LocaleSync`
(`apps/web/src/components/locale-sync.tsx`) lee `GET /me/profile` y, si el
locale del perfil no coincide con la cookie `didacta_locale`, **reescribe la
cookie con el del perfil**. Poner solo la cookie a `en-US` hace que la página
parpadee y vuelva a español. Por eso cada recorrido llama a
`setProfileLocale()` nada más existir la sesión, y `assertLocale()` revienta si
`<html lang>` no es el esperado — así una tanda inglesa nunca sale en español
sin que nadie se entere.

**Selectores por catálogo, no por texto literal.** `lib/i18n.ts` lee los mismos
JSON que consume la web (`apps/web/src/i18n/messages/<es|en>/*.json`), así que
el mismo recorrido funciona en los dos idiomas y una clave que falte en `en`
falla con un error explícito en vez de con un timeout.

**Nada de `networkidle`.** Con sesión iniciada la app abre dos canales SSE
(`/messaging/stream` y `/me/notifications/stream`) y la red no queda ociosa
nunca: cada captura se comía 30 s de timeout. `settle()` espera por el DOM
(sin esqueletos, imágenes decodificadas, sin mutaciones durante 400 ms).

**Datos neutros, regla whitelabel.** `lib/config.ts` es la única fuente de la
organización, las cuentas y el contenido que aparecen en pantalla:
`Academia Demo`, `Admin Demo`, `alumna@example.com`. Las páginas de la
documentación citan esos mismos nombres — si cambias uno, cambia también el
texto que lo menciona.

**Mismos datos en los dos idiomas.** Lo que se traduce es la interfaz, no el
contenido que teclea el operador. El curso se llama igual en la captura
española y en la inglesa: así la comparación entre ambas aísla el idioma de la
UI, y las páginas `.en.md` —que nombran `Academia Demo` / `Admin Demo` /
`Alumna Demo` en inglés— siguen describiendo lo que se ve.

**El SMTP se pone y se quita.** El enlace de «define tu contraseña» viaja por
email, así que el primer recorrido configura el SMTP por API antes de invitar a
la alumna y lo **borra** justo después: el segundo recorrido tiene que empezar
con la pestaña Notificaciones realmente vacía.

**Las claves de Stripe son inventadas.** No hace falta cuenta: la captura 12
del segundo recorrido documenta precisamente el error con el que Stripe rechaza
una clave inválida, y para eso la llamada tiene que ser real.
