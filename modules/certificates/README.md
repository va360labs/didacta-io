# mod.certificates

Emisión y gestión de certificados PDF tras completar curso.

## Qué hace

- Plantillas custom de certificado por tenant (logo, copy, layout).
- Emisión automática tras `learning.course.completed`.
- Numeración única por tenant.
- Persistencia del PDF firmado en EvidenceVault con SHA-256.
- Revocación con audit log.

## Cómo activar

Toggle desde `/admin/configuracion` → módulo `certificates`. Active por defecto.

## Eventos

- **Emite**: `certificates.issued`, `certificates.revoked`.
- **Consume**: `learning.course.completed` (auto-emisión).

## Permisos

- `certificates:read` — alumno puede ver/descargar el suyo.
- `certificates:write` — admin puede gestionar plantillas.
- `certificates:issue` — admin puede emitir manualmente o re-emitir.

## Tablas

- `mod_certificates_template` — plantillas por tenant.
- `mod_certificates_issued` — certificados emitidos con hash.

Ver `prisma/schema.prisma` del repo para detalles.
