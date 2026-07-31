# @didacta/api

Backend NestJS de Didacta.

## Arranque en dev

```bash
# Desde la raíz del monorepo
pnpm install
docker compose up -d           # levanta postgres, redis, minio, mailpit
cp env.example .env            # la primera vez
pnpm --filter @didacta/api dev
```

- API: http://localhost:4000
- OpenAPI / Swagger: http://localhost:4000/api/docs
- Liveness: http://localhost:4000/healthz
- Readiness: http://localhost:4000/readyz

## Stack

- **NestJS 10** con **Fastify** adapter (mejor throughput que Express)
- **Pino** para logs estructurados (`nestjs-pino`) con redacción de headers sensibles
- **OpenAPI 3.1** auto-generado con `@nestjs/swagger`
- **Vitest + supertest** para tests unitarios y e2e (vía `app.inject`)

## Estructura

```
apps/api/
├── src/
│   ├── main.ts              # bootstrap, Swagger, Fastify
│   ├── app.module.ts        # logger raíz + imports
│   └── health/              # /healthz y /readyz
├── tests/
│   └── health.e2e.test.ts   # tests end-to-end con app.inject
├── nest-cli.json
├── vitest.config.ts
└── tsconfig.json
```

## API versioning

Todos los endpoints del producto van bajo `/api/v1/*`. Los probes `/healthz`, `/readyz` y la doc `/api/docs` quedan fuera del prefijo por convención Kubernetes/observabilidad (ADR-006).
