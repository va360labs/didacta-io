# mod.theming

Personalización visual per-tenant para Didacta: logo, favicon, color primario (hue HSL), fuentes, custom CSS sanitizado, footer custom.

## Diseño

- Un único registro `mod_theming_tenant_theme` por tenant.
- El theme se carga server-side en el layout root del web (`apps/web/src/app/layout.tsx`) e inyecta `<style>` con CSS variables override de los tokens base de `globals.css`.
- Cambiar `brandHue` propaga a los 10 escalones `--color-brand-50..900` automáticamente (HSL math sobre `--brand-h`).
- Fuentes: whitelist limitada a fuentes Google Fonts oficialmente soportadas (latin subset).
- Custom CSS: sanitizado a un máximo de 16 KB, aplicado tras los tokens base.

## API pública

- `ThemingService.getOrCreate(tenantId)` — devuelve theme actual o lo crea con defaults Didacta.
- `ThemingService.update(tenantId, dto)` — actualiza parcialmente.
- `ThemingService.reset(tenantId)` — reset a defaults.

## Defaults Didacta

| Token             | Default              |
| ----------------- | -------------------- |
| brandHue          | 213 (azul confianza) |
| brandSaturation   | 70                   |
| displayFontFamily | Sora                 |
| bodyFontFamily    | Inter                |

## Eventos

Por ahora, sin eventos (cambio de theme no dispara nada externo).

## Permisos

- `theming.read` — leer el theme propio del tenant.
- `theming.write` — modificar el theme (solo `tenant_admin` y `super_admin`).
