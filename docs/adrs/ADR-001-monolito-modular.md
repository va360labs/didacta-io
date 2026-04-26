# ADR-001 — Monolito modular vs microservicios

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa (VA360 LABS)

## Contexto

Didacta debe soportar multi-tenant con módulos activables y evolucionar hacia SaaS. La elección entre monolito modular y microservicios define cómo se construye el sistema durante los próximos años, afecta a costes operacionales, velocidad de iteración y curva de aprendizaje del equipo.

## Decisión

**Monolito modular**: una sola aplicación desplegable, con módulos separados por _bounded contexts_. NestJS `DynamicModule` como mecanismo de modularización a nivel backend; workspaces pnpm + Turborepo a nivel monorepo.

Los módulos se registran vía `ModuleRegistry` (ver `@didacta/core-registry`) y declaran su contrato en `module.json` (ADR-008).

## Consecuencias

Positivas:

- **Simplicidad operacional**: un deploy, una base de datos, un stack de observabilidad.
- **Transacciones atómicas** entre módulos si el dominio lo requiere (ej. emitir certificado y registrar en audit log en la misma transacción).
- **Menor overhead** inicial que microservicios: sin service mesh, sin API gateway externo, sin coordinación distribuida.
- **Extraíble a futuro**: si un módulo necesita escalar independientemente en Fase 3+, se puede extraer a servicio separado manteniendo su contrato.

Negativas / riesgos:

- **Disciplina estricta** para no acoplar módulos entre sí (mitigado por el contrato de ADR-008 y tests de contrato).
- **Escalado vertical** por defecto (no horizontal por _bounded context_). Aceptable para el rango 0-10.000 usuarios concurrentes previsto en Fase 1-2.
- **Blast radius** mayor: un bug en un módulo puede afectar al proceso completo. Mitigado con feature flags y módulos activables por tenant.

## Alternativas consideradas

- **Microservicios desde día 1**: rechazado por complejidad operacional excesiva para el tamaño del equipo (Fase 1 ≈ 1-2 devs).
- **Monolito no modular**: rechazado por falta de aislamiento entre features. Difícil de razonar a partir de 5+ módulos.

## Referencias

- `docs/ARQUITECTURA-MODULAR.md`
- `docs/PRD.md` §4.1 Principios arquitectónicos
