-- Extensiones Postgres requeridas por Didacta
-- Se ejecuta automáticamente al inicializar el contenedor por primera vez

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Activa en Fase 1.C+ (mod.ai-tutor + embeddings). Requiere imagen
-- pgvector/pgvector:pg16 (ya configurada en docker-compose.alpha.yml).
CREATE EXTENSION IF NOT EXISTS "vector";
