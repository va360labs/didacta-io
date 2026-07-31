# @didacta/web

Frontend Next.js 15 de Didacta: app unificada de alumno + admin de tenant.

## Arranque en dev

```bash
pnpm install
pnpm --filter @didacta/web dev
# → http://localhost:3000
```

## Stack

- **Next.js 15** App Router + React 19 (RSC por defecto)
- **Tailwind CSS 4** con PostCSS (`@tailwindcss/postcss`)
- **TypeScript** estricto
- **Typed Routes** activado (experimental) — autocompletado de paths en `<Link href>`

## Estructura

```
apps/web/
├── src/app/
│   ├── layout.tsx       # RootLayout con metadata y fonts
│   ├── page.tsx         # Landing (reemplazada en Fase 1.A por /cursos)
│   └── globals.css      # Tailwind + theme tokens
├── next.config.ts
├── postcss.config.mjs
└── tsconfig.json
```

## Convenciones

- **RSC por defecto**: usar `"use client"` solo cuando sea imprescindible (event handlers, hooks de estado).
- **Accesibilidad WCAG 2.1 AA**: ARIA labels, navegación por teclado, contraste de colores.
- **i18n** (ES por defecto, EN desde día 1): a configurar en PR dedicado con `next-intl`.
- **shadcn/ui**: a instalar cuando se construya la UI real (Fase 1.A).

## Panel super_admin

Vive en `apps/super-admin` (aún no creado) para aislar responsabilidades y reducir riesgo. Este \`apps/web\` sirve al alumno y al \`tenant_admin\`.
