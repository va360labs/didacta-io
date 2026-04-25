-- Extensiones Postgres requeridas por LearnShip
-- Se ejecuta automáticamente al inicializar el contenedor por primera vez

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- pgvector se activa en Fase 1.C (mod.ai-tutor + embeddings).
-- Requiere imagen pgvector/pgvector:pg16 o equivalente con la extensión instalada.
-- CREATE EXTENSION IF NOT EXISTS "vector";
