# Security Policy

## Reportar una vulnerabilidad

Si descubres una vulnerabilidad de seguridad en Didacta, **por favor NO abras una issue pública** en GitHub.

### Cómo reportar

Manda un email a **`security@didacta.io`** con:

- **Descripción** del problema y su impacto.
- **Pasos para reproducirlo**, idealmente con un PoC mínimo.
- **Versión afectada** (`docker compose images` o tag de la imagen).
- **Tu nombre + manera de reconocerte** si quieres aparecer en los créditos de seguridad (`SECURITY-CREDITS.md`, se crea con el primer reporte acreditado) (opcional).

Si la vulnerabilidad es crítica y prefieres cifrar, pide la PGP key en el mismo email.

### Qué pasa después

| Plazo                        | Acción                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| **48 h hábiles**             | Acuse de recibo + asignación de severidad.                                 |
| **7 días**                   | Plan de mitigación + ETA del parche.                                       |
| **Variable según severidad** | Parche desarrollado y testeado.                                            |
| **Tras parche en main**      | Aviso público (sin detalle de exploit) y crédito al reporter si lo aceptó. |
| **+30 días**                 | Detalle técnico publicado en advisory.                                     |

## Severidad

| Nivel       | Ejemplos                                                                                                      | SLA parche    |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------- |
| **Crítica** | RCE, SQL injection en endpoint público, leak de credenciales / claves privadas, bypass de autenticación / RLS | 72 h          |
| **Alta**    | XSS persistente, escalación de privilegios entre tenants, leak de PII                                         | 7 días        |
| **Media**   | XSS reflejado, IDOR no crítico, denegación de servicio limitada                                               | 30 días       |
| **Baja**    | Information disclosure menor, problema de rate limit, mensaje de error con info técnica                       | Próxima minor |

## Versiones soportadas

Durante alpha cerrada (`v0.0.x-alpha`): solo el último alpha publicado. Si reportas un bug en un alpha viejo, te pedimos actualizar al último primero.

Cuando salgamos a beta y `v1.0.0`, esta tabla se actualizará con la política LTS final.

## Lo que NO contamos como vulnerabilidad

- Bugs funcionales que no comprometen seguridad → reporta como bug normal abriendo una issue en GitHub (plantilla de bug).
- Errores de configuración del usuario (ej. `AUTH_SECRET` débil que él mismo eligió).
- Dependencias con CVEs no explotables en nuestro contexto. Ejecutamos `pnpm audit` regularmente; los CVEs explotables sí los tratamos como vulnerabilidades.
- Bypass del chequeo de licencia EE en código local. La licencia se aplica por **contrato + soporte + parches**, no por DRM.

## Bug bounty

No tenemos programa formal de bug bounty durante alpha. Cuando publiquemos `v1.0.0` evaluaremos lanzar uno (probablemente con HackerOne o Intigriti).

Por ahora: agradecimiento público en `SECURITY-CREDITS.md` (opt-in) y, en algunos casos, swag de Didacta o invitación a Cloud gratis durante 6 meses.

## Comunicación con clientes Enterprise

Los clientes con licencia Enterprise activa reciben aviso por email a la dirección registrada en su licencia **antes** de que el advisory se haga público. Esto les da margen para parchear sus despliegues self-host.

## Contacto

- **`security@didacta.io`** — reportes y consultas.
- **`legal@didacta.io`** — temas legales relacionados con seguridad.
