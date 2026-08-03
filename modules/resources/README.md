# mod.resources

Biblioteca de recursos del tenant organizada por colecciones: material de apoyo (ficheros y enlaces) que cualquier miembro consulta y descarga, y que el staff cura.

## Edición

Community Edition. No requiere licencia Enterprise.

## Estado

Estable. Módulo first-party built-in (ADR-011/015): la lógica portable vive en `modules/resources/` y el host NestJS en `apps/api/src/modules/resources/`.

## Resumen funcional

- **Colecciones** con título, descripción y portada; el primer listado siembra las colecciones por defecto del tenant.
- **Recursos** de dos tipos: `FILE` (fichero subido al storage) y `LINK` (enlace externo).
- Cualquier miembro **consulta, descarga y comparte**; el **staff** crea y edita colecciones; el **autor** puede borrar lo suyo y el staff, todo.
- La descarga se contabiliza por recurso (`POST :id/download`).

## API pública

Prefijo global `/api/v1`, namespace `/modules/resources`. Todos los endpoints exigen sesión (Bearer):

- `GET /modules/resources/collections` — colecciones del tenant con nº de recursos.
- `POST /modules/resources/collections` · `GET /modules/resources/collections/:id` · `PUT /modules/resources/collections/:id` · `DELETE /modules/resources/collections/:id` — CRUD de colecciones (staff).
- `POST /modules/resources` — crea un recurso (`collectionId`, `kind` FILE/LINK, título, url…).
- `POST /modules/resources/:id/download` — registra y resuelve la descarga.
- `DELETE /modules/resources/:id` — borra (autor o staff).

Los ids malformados (no UUID) responden 404, nunca 500.

## Modelo de datos

- `mod_resources_collection` — la colección (título, descripción, portada).
- `mod_resources_resource` — el recurso (`kind` FILE/LINK, url/fichero, autor, contadores).

Todas con `tenant_id` + RLS (autodescubierta por `rls.sql`).

## Configuración

Sin settings propios de tenant ni ENV del host. Los ficheros usan el storage de la instalación (disco local o S3, según `STORAGE_DRIVER`).

## Dependencias

Sin dependencias de otros módulos. Los recursos ligados a una sesión de clase guardan el identificador lógico, sin FK cross-module (ADR-016).

## Eventos

**Emite**:

- `resources.collection.created` — al crear una colección.
- `resources.resource.created` — al publicar un recurso.
- `resources.resource.deleted` — al borrarlo.

**Consume**: ninguno.
