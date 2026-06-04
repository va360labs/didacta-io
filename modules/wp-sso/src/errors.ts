/**
 * Errores tipados del módulo wp-sso. El host los mapea a una razón estable
 * (`reason=...`) en el redirect a `/auth/error`, igual que OIDC/SAML.
 */
export type WpSsoErrorCode =
  | 'missing_token'
  | 'not_configured'
  | 'bad_signature'
  | 'expired'
  | 'ttl_too_long'
  | 'claim_invalid'
  | 'email_invalid'
  | 'audience_invalid'
  | 'issuer_invalid'
  | 'replayed'
  | 'invalid';

export class WpSsoTokenError extends Error {
  constructor(
    readonly code: WpSsoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WpSsoTokenError';
  }
}
