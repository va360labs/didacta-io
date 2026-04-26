# ADR-004 — Streaming provider Fase 1: Zoom API

- **Estado**: Accepted
- **Fecha**: 2026-04-24
- **Deciders**: Valentín Ayesa

## Contexto

El módulo `mod.zoom-live` (Fase 1.B) requiere aula virtual síncrona con registro nominal de asistencia y grabaciones archivadas al Evidence Vault (crítico para expedientes Fundae). Opciones evaluadas:

- **Zoom API + SDK Web**: madura, grabaciones + transcripciones resueltas, usuario final familiarizado.
- **LiveKit self-hosted**: control total, costes previsibles, requiere infra propia.
- **Jitsi**: open source, menos robusto en escalado.
- **Daily.co**: SaaS, buen SDK, menor adopción.

## Decisión

**Zoom API + SDK Web** para Fase 1. Integración vía cuenta Server-to-Server OAuth.

La dependencia **NO se expone directamente** en los módulos de negocio: vive detrás de la interfaz abstracta `LiveSessionProvider` (a definir en `packages/core-kernel` junto a las demás abstracciones de infraestructura). `mod.zoom-live` es la implementación concreta; en Fase 3 podrá añadirse `mod.live-streaming-native` (LiveKit) como implementación alternativa.

## Consecuencias

Positivas:

- **Time-to-market rápido**: ya hay cuenta Zoom activa y MCP conectado. Cero setup de infra.
- **Grabaciones, transcripciones y registro de participantes** resueltos por Zoom.
- **UX familiar** para alumnos y formadores.

Negativas / riesgos:

- **Dependencia de proveedor externo**: si Zoom cambia API (ya sucedió con la transición OAuth App → Server-to-Server), requiere migración.
- **Costes por seat** en escala: si Didacta llega a 10k+ usuarios activos, Zoom puede no ser el modelo óptimo.
- **Residencia de datos**: grabaciones pasan por infra de Zoom (US). Evaluar si aplica a requisitos Fundae/RGPD para datos sensibles.

**Plan B documentado**: Fase 3, si el coste o los requisitos lo demandan, implementar `mod.live-streaming-native` con LiveKit. La abstracción `LiveSessionProvider` garantiza swap sin tocar módulos dependientes.

## Alternativas consideradas

- **LiveKit self-hosted desde día 1**: rechazado por sobrecoste operacional en Fase 1.
- **Jitsi**: rechazado por menor robustez en escalado y ausencia de grabaciones con transcripción nativa.
- **Daily.co**: interesante pero sin ventaja clara sobre Zoom en este momento.

## Referencias

- `docs/PRD.md` §6 Stack cerrado
- `docs/PLAN-FASES.md` Fase 1.B
- Test de contrato: `packages/core-kernel/tests/*.test.ts` (a añadir `LiveSessionProvider` cuando la interfaz exista)
