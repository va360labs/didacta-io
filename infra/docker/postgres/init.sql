-- Extensiones Postgres requeridas por LearnShip
-- Se ejecuta automáticamente al inicializar el contenedor por primera vez

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
