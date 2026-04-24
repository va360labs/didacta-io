# Infraestructura

Configuración de infra del proyecto.

## Estructura

```
infra/
├── docker/
│   └── postgres/
│       └── init.sql       # Extensiones Postgres (uuid-ossp, pgcrypto, vector)
└── README.md
```

## Stack de desarrollo local (`docker-compose.yml` en la raíz)

| Servicio   | Imagen                   | Puerto(s)  | Uso                                     |
| ---------- | ------------------------ | ---------- | --------------------------------------- |
| postgres   | `pgvector/pgvector:pg16` | 5432       | Base de datos con pgvector incluido     |
| redis      | `redis:7-alpine`         | 6379       | Cache y colas BullMQ                    |
| minio      | `minio/minio:latest`     | 9000, 9001 | Object storage S3-compatible            |
| minio-init | `minio/mc:latest`        | -          | Crea bucket `learnship-dev` al arrancar |
| mailpit    | `axllent/mailpit:latest` | 1025, 8025 | SMTP de captura + UI web de emails      |

## Cómo arrancar

```bash
cp env.example .env        # la primera vez
docker compose up -d       # levantar en background
docker compose logs -f     # seguir logs
docker compose down        # parar
docker compose down -v     # parar y borrar volúmenes (reset completo)
```

## Healthchecks

Todos los servicios tienen healthchecks configurados. Verificá estado con:

```bash
docker compose ps
```

## Accesos rápidos (dev)

- PostgreSQL: `psql postgresql://learnship:learnship_dev@localhost:5432/learnship`
- Redis CLI: `redis-cli -h localhost -p 6379`
- MinIO Console: http://localhost:9001 (user: `learnship`, password: `learnship_dev`)
- MailPit UI: http://localhost:8025

## Entornos remotos (staging, prod)

Pendientes de configurar en Easypanel (ver PLAN-FASES §Fase 0). Una vez creados se documentan aquí.
