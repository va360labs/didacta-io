/**
 * Tipos de la config de WP-SSO por tenant. La config vive cifrada en BD
 * (`PrismaTenantConfigService`, isSecret) — NO en variables de entorno. El admin
 * la gestiona desde el panel (`/admin/sso-wordpress`), mismo patrón que OIDC.
 */

/** Módulo + key bajo los que se guarda la config en tenant_setting. */
export const WP_SSO_CONFIG_MODULE_NAME = 'wp-sso';
export const WP_SSO_CONFIG_KEY = 'config';
/** Audiencia por defecto del token (coincide con el plugin de WordPress). */
export const WP_SSO_AUDIENCE_DEFAULT = 'didacta-wp-sso';

/**
 * Config completa persistida (cifrada at-rest porque incluye `sharedSecret`).
 * Todo el objeto se guarda con `isSecret:true`.
 */
export interface TenantWpSsoConfig {
  /** Si el SSO está activo para el tenant. */
  enabled: boolean;
  /** Secreto HMAC compartido con WordPress. Nunca se devuelve en vistas safe. */
  sharedSecret: string;
  /** home_url de WordPress (claim `iss` esperado + destino del auto-bounce). */
  issuer?: string;
  /** Audiencia esperada del token. Default `didacta-wp-sso`. */
  audience?: string;
  /** Auto-provisiona usuarios nuevos en el primer SSO. */
  autoCreate: boolean;
  /** El signin rebota a WordPress (modo `try`) si no hay sesión Didacta. */
  autoRedirect: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Vista para el panel admin — SIN el secreto en claro. */
export interface SafeWpSsoConfigView {
  enabled: boolean;
  /** True si hay secreto guardado (el plaintext nunca se devuelve). */
  hasSecret: boolean;
  issuer: string;
  audience: string;
  autoCreate: boolean;
  autoRedirect: boolean;
  /** URL exacta a pegar en `DIDACTA_SSO_CALLBACK` de wp-config.php (incluye el slug). */
  callbackUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Estado público (sin auth) que consume el signin para el auto-bounce. */
export interface WpSsoPublicStatus {
  configured: boolean;
  autoRedirect: boolean;
  wordpressUrl: string | null;
}
