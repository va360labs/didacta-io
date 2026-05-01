# UI · Patrón de gating Enterprise (estilo n8n)

> Convención obligatoria para toda feature de pago (capability EE) que tenga superficie de UI.
> Aprobada por producto el 2026-05-01.

## Principio

**Community ve TODO lo que existe en Enterprise, pero bloqueado tras un candado con CTA de upgrade.**

Inspirado en cómo n8n muestra "Enterprise Edition" features a los usuarios Community: la entrada está visible
en sidebar/menú, al hacer clic se renderiza una tarjeta de upsell explicando qué desbloquea Enterprise y un
botón a pricing. Nunca un 404, nunca un menú "vacío" para community, nunca una redirección silenciosa.

**Por qué este patrón**:

1. **Discoverability** — el usuario community descubre features que podría querer.
2. **Honestidad comercial** — no esconde lo que existe; deja al usuario decidir.
3. **Conversión** — cada feature EE es una superficie de pricing.
4. **Coherencia visual** — la app se ve igual en Community y Enterprise; cambia solo el contenido del panel.

## Reglas duras (cumplir siempre)

1. **El sidebar/menú NO se filtra por capability EE.** Las entradas de admin (SSO, SCIM, Branding, Dominios, Rate Limit, Auditoría avanzada, etc.) se renderizan idéntico en Community y Enterprise.

2. **La página existe y es navegable**. Nunca un `redirect()` ni `notFound()` por falta de capability.

3. **El panel real va envuelto en `<EeGate>`**. Si la capability no está activa, se renderiza la upsell card.

4. **El header de la página (h1 + descripción) va FUERA del `<EeGate>`**. Así el usuario community ve qué es la feature aunque no pueda usarla.

5. **El backend SIEMPRE gatea con `@RequiresCapability` y devuelve 402 Payment Required**. La UI es solo UX; la fuente de verdad es el servidor. Si un cliente community llamara igualmente a un endpoint admin, recibe 402 vía `LicenseExceptionFilter`.

6. **Cada feature EE tiene su propia upsell card específica**. No usar la genérica `DefaultLockedView` del SDK en producción — una card propia con el copy de la feature convierte mejor.

7. **El CTA siempre apunta a `https://didacta.io/pricing`** con `target="_blank" rel="noopener noreferrer"`.

## Estructura canónica de página EE

```tsx
'use client';

import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminFeaturePage() {
  return (
    <div className="flex flex-col gap-6">
      {/* 1. Header SIEMPRE visible (community + enterprise) */}
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Nombre de la feature</h1>
        <p className="text-text-muted">
          Qué hace la feature en una frase clara orientada al beneficio.
        </p>
      </header>

      {/* 2. Panel real envuelto en EeGate con fallback explícito */}
      <EeGate
        capability={LICENSE_CAPABILITIES.FEATURE_KEY}
        fallback={<FeatureUpsellCard />}
      >
        <FeaturePanel />
      </EeGate>
    </div>
  );
}

function FeatureUpsellCard() {
  return (
    <Card role="region" aria-label="Nombre feature (Enterprise)" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          {/* Copy específico de la feature: qué desbloquea, para quién, qué problema resuelve */}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:feature.key
          </code>
          .
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
```

## Modos de `<EeGate>` — cuándo usar cada uno

El componente `<EeGate>` del `license-sdk/react` soporta tres modos. Para Didacta, la regla es:

| Modo | Uso en Didacta | Cuándo |
|------|---------------|--------|
| `locked` (default) | **Estándar para páginas admin EE.** Renderiza fallback. | Una página entera dedicada a la feature EE. |
| `limited` | **Componentes embebidos dentro de páginas mixtas.** | Una sección dentro de una página que mezcla CE y EE (ej. una tab "Avanzado" en /admin/seguridad). |
| `hidden` | **Casi nunca.** Solo si la presencia visual del item rompería el flujo (raro). | Reservado a casos donde mostrar el bloqueo daña UX más que ayuda. |

`hidden` debe justificarse en PR. La regla por defecto es `locked` o `limited`.

## Backend — pareja obligatoria con la UI

Para cada panel EE en frontend, el backend debe:

1. Decorar todos los endpoints admin con `@RequiresCapability(LICENSE_CAPABILITIES.FEATURE_KEY)`.
2. Registrar el `LicenseExceptionFilter` global en el módulo (mapea a 402).
3. Si el módulo es CE (no transversal del core), gatear sus endpoints **públicos** según corresponda.

Ejemplo controller:

```ts
@Controller('admin/sso/oidc')
@RequiresCapability(LICENSE_CAPABILITIES.SSO_OIDC)
export class OidcAdminController {
  // ... todos los endpoints de este controller requieren la capability
}
```

## Páginas que ya aplican el patrón (referencia)

- `apps/web/src/app/(app)/admin/sso/page.tsx` → `SSO_OIDC`
- `apps/web/src/app/(app)/admin/scim/page.tsx` → `SCIM`
- `apps/web/src/app/(app)/admin/branding/page.tsx` → `WHITE_LABEL`
- `apps/web/src/app/(app)/admin/dominios/page.tsx` → `CUSTOM_DOMAINS`
- `apps/web/src/app/(app)/admin/seguridad/page.tsx` → `MFA_ENFORCEMENT`
- `apps/web/src/app/(app)/admin/rate-limit/page.tsx` → `API_RATE_LIMIT_ELEVATED`

Cualquier feature EE nueva debe seguir el mismo patrón antes de marcarse como "lista".

## Las 11 capabilities EE (ver `packages/license-sdk/src/capabilities.ts`)

| Key | Capability | Estado UI |
|-----|------------|-----------|
| `MULTI_TENANT_REAL` | feat:multi_tenant.real | sin UI dedicada (transversal) |
| `SSO_SAML` | feat:sso.saml | **pendiente — ART-004** |
| `SSO_OIDC` | feat:sso.oidc | ✅ /admin/sso |
| `SCIM` | feat:scim | ✅ /admin/scim |
| `MFA_ENFORCEMENT` | feat:mfa.enforcement | ✅ /admin/seguridad |
| `WHITE_LABEL` | feat:white_label | ✅ /admin/branding |
| `CUSTOM_DOMAINS` | feat:custom_domains | ✅ /admin/dominios |
| `AUDIT_LONG_RETENTION` | feat:audit.long_retention | pendiente |
| `REPORTS_ADVANCED_SIGNED` | feat:reports.advanced_signed | pendiente |
| `API_WEBHOOKS_HIGH_THROUGHPUT` | feat:api.webhooks.high_throughput | pendiente |
| `API_RATE_LIMIT_ELEVATED` | feat:api.rate_limit.elevated | ✅ /admin/rate-limit |

## Diferencia con módulos CE puros

Esto **NO aplica** a módulos Community (mod.billing, mod.ai-content, mod.ai-tutor, etc.). Esos están
disponibles para todo Community sin gating. El gating EE es solo para las **11 capabilities transversales
del CORE** que viven en archivos `*.ee.ts` dentro de `apps/api/src/`, `packages/core-kernel/`, o
`packages/license-sdk/src/`.

Si una feature está en `modules/<name>/`, NO debe tener `<EeGate>`. Si tiene `<EeGate>`, NO debe vivir
en `modules/`. Esta regla es estricta y la valida `module-doctor`.

## Checklist de PR para una nueva feature EE

- [ ] Capability declarada en `packages/license-sdk/src/capabilities.ts` (con JSDoc).
- [ ] Backend: controller decorado con `@RequiresCapability`.
- [ ] Backend: tests unitarios verifican 402 sin licencia.
- [ ] Frontend: página visible siempre en sidebar (sin filtrar por licencia).
- [ ] Frontend: header h1 + descripción FUERA de `<EeGate>`.
- [ ] Frontend: panel real DENTRO de `<EeGate>` con `fallback` específico.
- [ ] Frontend: upsell card propia con copy de la feature + CTA a `/pricing`.
- [ ] FEATURE-MATRIX actualizada con la fila Community ❌ / Enterprise ✅.
- [ ] Notion: capability marcada como pilotada en página "Estado del arte".
