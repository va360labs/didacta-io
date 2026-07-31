# mod.wp-sso — Single Sign-On desde WordPress

Permite que un usuario **ya autenticado en WordPress** entre a Didacta sin volver
a iniciar sesión.

## Flujo

```
WordPress (usuario logueado)                Didacta
  │  clic en "Ir a Didacta"                    │
  │  el plugin firma un JWT HS256 corto        │
  │  (email, name, iat, exp≤5min, jti único)   │
  │                                            │
  └──── 302 …/modules/wp-sso/callback?token=──▶│ verifica firma+aud+iss+exp+TTL
                                               │ marca jti usado (single-use, Redis)
                                               │ resuelve user por email (crea alumno si no existe)
                                               │ emite sesión (TokenService)
        ◀──── 302 /auth/callback?accessToken&refreshToken ───┘
```

El token es **corto** y de **un solo uso** (jti, anti-replay). El secreto HMAC
sólo lo conocen WordPress y Didacta; nunca viaja al navegador.

## Arquitectura

- **Este paquete** (`@didacta/mod-wp-sso`): parte portable — verificación del token
  (`verifyWpSsoToken`, pura, jose HS256), manifest y el **plugin de WordPress**
  (`wordpress/didacta-sso.php`).
- **Host** (`apps/api/src/sso/wp/`): el callback + emisión de sesión, porque firmar
  un JWT de sesión Didacta es privilegio del core (`TokenService`). Mismo patrón
  que OIDC/SAML, pero **Community** (sin gate Enterprise).

## Configuración en Didacta (host)

Variables de entorno:

| Var                    | Obligatoria | Descripción                                                                |
| ---------------------- | ----------- | -------------------------------------------------------------------------- |
| `WP_SSO_SHARED_SECRET` | sí          | Secreto HMAC compartido con WordPress (largo y aleatorio).                 |
| `WP_SSO_TENANT_SLUG`   | sí          | Slug del tenant destino de los usuarios de WordPress.                      |
| `WP_SSO_ISSUER`        | no          | URL del WordPress origen; si se define, el token debe declararla en `iss`. |
| `WP_SSO_AUDIENCE`      | no          | Audiencia esperada (default `didacta-wp-sso`).                             |
| `WP_SSO_AUTOCREATE`    | no          | `false` para NO crear usuarios nuevos (default crea con rol `alumno`).     |

## Configuración en WordPress

1. Copia `wordpress/didacta-sso.php` a `wp-content/plugins/didacta-sso/` y actívalo.
2. En `wp-config.php` (mismos valores que en Didacta):
   ```php
   define('DIDACTA_SSO_SECRET', 'el-mismo-WP_SSO_SHARED_SECRET');
   define('DIDACTA_SSO_CALLBACK', 'https://dev.didacta.io/api/v1/modules/wp-sso/callback');
   ```
3. Enlaza a Didacta: shortcode `[didacta_sso_button label="Ir a Didacta"]` o la URL
   `https://tu-wordpress/?didacta_sso=go`.

## Seguridad

- Firma HS256, `exp` ≤ 300 s (Didacta rechaza tokens más longevos).
- `jti` de un solo uso (Redis `SET NX EX`; fallback in-memory si no hay Redis).
- Verifica audiencia y (opcional) issuer.
- Auto-provisioning configurable; los emails se normalizan (trim + lowercase).
