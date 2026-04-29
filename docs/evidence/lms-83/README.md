# Evidencia LMS-83 — XML Comunicación de inicio de grupo Fundae

## Run E2E

- **Branch**: `feat/lms-83-xml-inicio-grupo`
- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25104425263>
- **Resultado**: ✅ success
- **Spec**: `apps/e2e/tests/fundae-group-start-xml.spec.ts`

## Cobertura del spec

1. Cleanup defensivo de empresas con NIF `V12345674` (por si quedó leftover de runs previos).
2. Setup completo: empresa (`V12345674`) + acción + grupo + 1 participante (admin como user, NIF alumno snapshot `12345678Z`).
3. `GET /api/v1/admin/fundae/groups/:id/start-xml` → 200 con `Content-Type: application/xml`.
4. El XML resultante contiene:
   - `<comunicacionInicioGrupo>` con xmlns Fundae.
   - `<codigoAccion>` y `<numeroGrupo>` correctos.
   - `<nif>V12345674</nif>` y `<plantilla>25</plantilla>` de la empresa.
   - `<participantesIniciales total="1">` con `<nif>12345678Z</nif>` del alumno.
5. `GET .../groups/<UUID-inexistente>/start-xml` → 404 con `code: FUNDAE_GROUP_NOT_FOUND`.
6. Cleanup empresa al final.

## Run CI

- **Workflow run**: <https://github.com/va360labs/didacta/actions/runs/25104421041>
- **Resultado**: ✅ success
- 7 tests unitarios `buildGroupStartXml` + tests previos del módulo + tests del controller.

## Hallazgo técnico (post-mortem del primer run)

El primer run E2E falló con status ≠ 404 al consultar grupo inexistente. Causa raíz: el decorador `@Header('Content-Type', 'application/xml; charset=utf-8')` del controller establece el header al construir la response, pero cuando el handler lanza una excepción, el `FundaeErrorFilter` intenta enviar JSON con ese header ya seteado, lo que en Fastify provoca comportamiento indeterminado.

**Fix:** sustituir `@Header` por `@Res() reply` y aplicar `reply.header(...).status(200).send(xml)` solo en la rama de éxito. Las excepciones siguen al filter sin colisión. Documentado inline en `fundae-groups.controller.ts:142`.
