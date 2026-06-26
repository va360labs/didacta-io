import { parseModuleManifest, type ModuleManifest } from '@didacta/core-kernel';

/**
 * Manifest de `mod.wp-sso` — Single Sign-On desde WordPress.
 *
 * Es un módulo built-in (Community, sin gate Enterprise): emitir sesión es
 * privilegio del core, así que el callback vive en el host (apps/api/src/sso/wp)
 * usando TokenService. Este paquete aporta la parte PORTABLE: verificación del
 * token, contrato del manifest y el plugin de WordPress (carpeta `wordpress/`).
 */
export const manifest: ModuleManifest = parseModuleManifest({
  name: 'mod.wp-sso',
  displayName: 'SSO desde WordPress',
  description:
    'Permite que los usuarios autenticados en WordPress entren a Didacta sin volver a iniciar sesión. WordPress firma un token corto (HMAC) y Didacta lo verifica y emite la sesión.',
  version: '0.2.0',
  author: 'VA360 LABS',
  license: 'Proprietary',
  category: 'integration',
  coreVersionRequired: '^1.0.0',
  tablePrefix: 'mod_wpsso_',
  permissions: ['wp-sso.callback.exchange'],
  eventsEmitted: ['wp-sso.signin.success', 'wp-sso.user.provisioned', 'wp-sso.account.linked'],
  eventsConsumed: [],
  apiNamespace: '/modules/wp-sso',
});
