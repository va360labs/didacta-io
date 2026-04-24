# ADR-006 — API versioning: URL path

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

La API pública de LearnShip debe permitir evoluciones incompatibles (breaking changes) sin romper clientes existentes. Cuatro estrategias posibles:

1. **URL path**: `/api/v1/*`, `/api/v2/*`
2. **Header**: `Accept: application/vnd.learnship.v2+json`
3. **Content negotiation** (variantes de media types)
4. **Query param**: `?version=2`

## Decisión

**Versionado por URL path**: todos los endpoints de negocio viven bajo `/api/v1/*`. Health probes (`/healthz`, `/readyz`) y docs (`/api/docs`) quedan fuera del prefijo por convención.

Cambios breaking exigen un **major bump** (`/api/v2/`) y un **periodo de desprecación** con headers:

```http
Deprecation: Sun, 01 Mar 2027 00:00:00 GMT
Sunset: Sun, 01 Sep 2027 00:00:00 GMT
Link: <https://docs.learnship.dev/migration-v1-v2>; rel="deprecation"
```

## Consecuencias

Positivas:

- **Trivialmente cacheable** por path: CDNs, proxies y browsers no necesitan conocer headers custom.
- **Debugging simple**: logs y trazas muestran la versión usada sin inspeccionar headers.
- **Clientes explícitos**: el consumidor sabe exactamente qué versión está llamando.
- **Coexistencia**: dos versiones corriendo en paralelo sin colisión.

Negativas / riesgos:

- **Mantenimiento de 2 versiones** durante la desprecación: cada endpoint crítico se implementa dos veces. Mitigación: desprecar con tiempo suficiente y comunicar proactivamente.
- **SDK versionado**: `@learnship/sdk` sigue el mismo SemVer que la API (sdk 1.x ↔ api v1, sdk 2.x ↔ api v2).

## Alternativas consideradas

- **Header versioning**: rechazado por complejidad de debug y caching.
- **Content negotiation**: curva de aprendizaje alta para consumidores no-REST-purist.
- **Query param**: problemas con caching de proxies que normalizan URLs.

## Reglas operacionales

- **Sin breaking changes en v1**. Agregar campos a responses está permitido (additive). Cambiar semántica o quitar campos exige major bump.
- **Desprecar al menos 6 meses** antes de cerrar una versión.
- **OpenAPI** vive en `/api/docs` (Swagger UI) y `/api/docs.json` (spec crudo) para SDK generation automática.

## Referencias

- `apps/api/src/main.ts`
- `docs/PRD.md` §11 APIs y contratos
- [RFC 8594 – Sunset HTTP Header](https://datatracker.ietf.org/doc/html/rfc8594)
