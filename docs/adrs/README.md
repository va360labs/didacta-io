# Architecture Decision Records

Registro de decisiones arquitectónicas no triviales. Cada ADR es inmutable una vez aceptado: si una decisión se revisa, se crea una nueva ADR que la reemplaza (estado `Superseded`).

## Convenciones

- **Numeración correlativa**: `ADR-NNN-<slug>.md`
- **Formato**: Contexto → Decisión → Consecuencias → Alternativas consideradas
- **Estados**: `Proposed`, `Accepted`, `Deprecated`, `Superseded`
- **Idioma**: español
- **Notion**: cada ADR tiene un mirror en la [DB de Notion](https://www.notion.so/LMS-Ship-34cb609a124c80aa996bfec23268cad4) para discusión. El archivo en `docs/adrs/` es la versión **canónica**.

## Índice

| N°  | Título                                     | Estado   |
| --- | ------------------------------------------ | -------- |
| 001 | Monolito modular vs microservicios         | Accepted |
| 002 | Multi-tenancy strategy: Row-Level Security | Accepted |
| 003 | Auth provider: Auth.js v5                  | Accepted |
| 004 | Streaming provider Fase 1: Zoom API        | Accepted |
| 005 | ORM: Prisma 5                              | Accepted |
| 006 | API versioning: URL path                   | Accepted |
| 007 | Event bus: outbox + BullMQ + webhooks      | Accepted |
| 008 | Contrato de módulo                         | Accepted |

## Cuándo escribir una ADR

- Cambio en el core que afecte a múltiples módulos.
- Elección de tecnología externa (DB, auth provider, streaming, IA).
- Política transversal (versionado de API, idioma por defecto, convención de eventos).
- Cualquier decisión que un reviewer nuevo en 6 meses preguntará "¿por qué hicieron esto así?".

Si dudás, **escribí la ADR**. El coste es bajo, el beneficio alto.
