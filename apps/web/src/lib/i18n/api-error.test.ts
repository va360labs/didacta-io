import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage, CODES_WITH_DETAIL } from './api-error';
import { labelOr, type TranslatorLike } from './labels';

const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'errors' });
const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'errors' });

function httpError(message: string, code?: string, detail?: string): ApiHttpError {
  return new ApiHttpError({ message, status: 400, code, detail });
}

describe('apiErrorMessage', () => {
  it('code conocido → mensaje traducido del catálogo', () => {
    const e = httpError('Se requiere verificación MFA.', 'mfa_required');
    expect(apiErrorMessage(e, tEn)).toBe('Two-step verification is required to continue.');
    expect(apiErrorMessage(e, tEs)).toBe('Se requiere verificación en dos pasos para continuar.');
  });

  it('code desconocido → fallback honesto al message del backend', () => {
    const e = httpError('Algo específico del backend.', 'CODE_QUE_NO_EXISTE');
    expect(apiErrorMessage(e, tEn)).toBe('Algo específico del backend.');
  });

  it('sin code → message del backend', () => {
    expect(apiErrorMessage(httpError('Curso no encontrado.'), tEn)).toBe('Curso no encontrado.');
  });

  it('code con punto (rompería el path de namespaces) → se ignora', () => {
    const e = httpError('Mensaje.', 'a.b');
    expect(apiErrorMessage(e, tEn)).toBe('Mensaje.');
  });

  it('Error genérico → su message', () => {
    expect(apiErrorMessage(new Error('boom'), tEn)).toBe('boom');
  });

  it('TypeError de red (Failed to fetch) → errors.unknown, nunca el mensaje del motor', () => {
    expect(apiErrorMessage(new TypeError('Failed to fetch'), tEn)).toBe(
      'Something went wrong. Please try again.',
    );
    expect(apiErrorMessage(new TypeError('Load failed'), tEs)).toBe(
      'Algo salió mal. Inténtalo de nuevo.',
    );
  });

  it('no-Error (throw raro) → errors.unknown', () => {
    expect(apiErrorMessage('cadena', tEn)).toBe('Something went wrong. Please try again.');
    expect(apiErrorMessage(undefined, tEs)).toBe('Algo salió mal. Inténtalo de nuevo.');
  });
});

// ============================================================================
// Codes que llevan diagnóstico de un sistema externo (`ApiError.detail`).
// El bug que cierran: el catálogo EN traducía la frase y BORRABA el detalle,
// así que el admin anglófono veía "Stripe rejected the key." sin saber por qué,
// mientras el español sí lo veía (no había key ES y caía al message crudo).
// ============================================================================
describe('apiErrorMessage con detalle estructurado', () => {
  const STRIPE_DETAIL = 'Invalid API Key provided: sk_test_***1234';

  it('el detalle de Stripe llega ENTERO en los dos idiomas', () => {
    const e = httpError(
      `Stripe rechazó la clave: ${STRIPE_DETAIL}`,
      'ADMIN_STRIPE_KEY_REJECTED',
      STRIPE_DETAIL,
    );
    expect(apiErrorMessage(e, tEn)).toBe(`Stripe rejected the key: ${STRIPE_DETAIL}`);
    expect(apiErrorMessage(e, tEs)).toBe(`Stripe rechazó la clave: ${STRIPE_DETAIL}`);
    // El español es byte a byte el mensaje crudo del backend (no cambia nada
    // de lo que ve hoy el admin español).
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
  });

  it('el error del MTA llega entero en los dos idiomas', () => {
    const e = httpError('SMTP falló: auth failed', 'ADMIN_SMTP_TEST_FAILED', 'auth failed');
    expect(apiErrorMessage(e, tEn)).toBe('SMTP failed: auth failed');
    expect(apiErrorMessage(e, tEs)).toBe('SMTP falló: auth failed');
  });

  it('CAMINO DEGRADADO: code con detalle esperado pero SIN detail → message crudo', () => {
    // API vieja contra front nuevo, o un MTA que falla sin devolver texto.
    // Nunca la frase traducida con el hueco vacío ni la key en pantalla.
    const e = httpError('SMTP falló: sin detalle', 'ADMIN_SMTP_TEST_FAILED');
    expect(apiErrorMessage(e, tEn)).toBe('SMTP falló: sin detalle');
    expect(apiErrorMessage(e, tEn)).not.toContain('ADMIN_SMTP_TEST_FAILED');
    expect(apiErrorMessage(e, tEn)).not.toBe('SMTP failed: ');
  });

  it('CAMINO DEGRADADO: detail vacío o solo espacios cuenta como ausente', () => {
    for (const detail of ['', '   ']) {
      const e = httpError('Stripe rechazó la clave: x', 'ADMIN_STRIPE_KEY_REJECTED', detail);
      expect(apiErrorMessage(e, tEn)).toBe('Stripe rechazó la clave: x');
    }
  });

  it('un code SIN detalle esperado ignora el campo aunque venga', () => {
    const e = httpError('Se requiere verificación MFA.', 'mfa_required', 'ruido');
    expect(apiErrorMessage(e, tEn)).toBe('Two-step verification is required to continue.');
  });

  it('el diagnóstico del IdP llega entero en los dos idiomas', () => {
    const detail = 'access_denied — el usuario canceló el consentimiento';
    const e = httpError(`IdP devolvió error: ${detail}`, 'SSO_OIDC_IDP_ERROR', detail);
    expect(apiErrorMessage(e, tEn)).toBe(`The identity provider returned an error: ${detail}`);
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
  });

  it('el motivo del rechazo SAML llega entero en los dos idiomas', () => {
    const detail = 'Signature validation failed: digest mismatch';
    const e = httpError(`SAMLResponse inválido: ${detail}`, 'SSO_SAML_RESPONSE_INVALID', detail);
    expect(apiErrorMessage(e, tEn)).toBe(`Invalid SAMLResponse: ${detail}`);
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
  });

  it('el error del MTA de /tenant-settings llega entero en los dos idiomas', () => {
    const detail = '535 5.7.8 Username and Password not accepted';
    const e = httpError(`SMTP falló: ${detail}`, 'TENANT_SETTINGS_SMTP_TEST_FAILED', detail);
    expect(apiErrorMessage(e, tEn)).toBe(`SMTP failed: ${detail}`);
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
  });

  it('el diagnóstico de Stripe al rechazar la firma del webhook no se pierde', () => {
    const detail = 'No signatures found matching the expected signature for payload';
    for (const code of ['BILLING_WEBHOOK_SIGNATURE_REJECTED', 'SUBS_WEBHOOK_SIGNATURE_REJECTED']) {
      const e = httpError(`Firma del webhook inválida: ${detail}`, code, detail);
      expect(apiErrorMessage(e, tEn)).toBe(`Invalid webhook signature: ${detail}`);
      expect(apiErrorMessage(e, tEs)).toBe(e.message);
    }
  });

  it('un límite numérico se interpola SIN separador de miles en ninguno de los dos', () => {
    // El backend manda el límite como string precisamente para que ICU no lo
    // formatee como número: si lo hiciera, el español pintaría "5.242.880" y
    // dejaría de ser byte a byte el `message` que ya mandaba.
    const e = httpError(
      'El archivo debe pesar entre 1 byte y 5242880 bytes.',
      'STORAGE_FILE_SIZE_OUT_OF_RANGE',
      '5242880',
    );
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
    expect(apiErrorMessage(e, tEn)).toBe('The file must be between 1 byte and 5242880 bytes.');
  });

  it('los dos catálogos declaran {detail} en TODOS los codes que lo interpolan', () => {
    // Recorre la lista REAL, no una copia: añadir un code a CODES_WITH_DETAIL y
    // olvidar una de las dos traducciones rompe aquí, no en producción.
    // `TranslatorLike` (la misma forma que consume `apiErrorMessage`) porque
    // los dos translators tienen tipos distintos —uno por catálogo— y la unión
    // de sus overloads no es invocable con una key dinámica.
    const CATALOGOS: ReadonlyArray<readonly [string, TranslatorLike]> = [
      ['es', tEs],
      ['en', tEn],
    ];
    for (const code of CODES_WITH_DETAIL) {
      for (const [locale, t] of CATALOGOS) {
        expect(t.has(code), `${locale}: falta la key ${code} en el catálogo`).toBe(true);
        const text = t(code, { detail: 'ZZ' });
        expect(text, `${locale}/${code} no interpola {detail}`).toContain('ZZ');
        // La key cruda en pantalla es el síntoma de un ICU que no resolvió.
        expect(text, `${locale}/${code} pinta la key`).not.toContain(code);
      }
    }
  });

  it('el catálogo ES rinde byte a byte el `message` del backend', () => {
    // La garantía de que este PR no cambia NADA de lo que ve el usuario
    // español: para cada code, la frase ES traducida con el detalle es la misma
    // cadena que el backend ya componía.
    const CASOS: ReadonlyArray<readonly [string, string, string]> = [
      ['ACCESS_GROUPS_SLUG_TAKEN', 'Ya existe un grupo con el slug "socios"', 'socios'],
      ['ADMIN_CUSTOM_DOMAIN_EXISTS', 'El dominio aula.acme.com ya está registrado para este tenant.', 'aula.acme.com'], // prettier-ignore
      ['ADMIN_CUSTOM_DOMAIN_NOT_FOUND', 'Dominio 7f3a no encontrado.', '7f3a'],
      ['ADMIN_ROLE_NOT_ASSIGNABLE', 'Rol "super_admin" no asignable.', 'super_admin'],
      ['ADMIN_SMTP_TEMPLATE_NOT_FOUND', 'No existe la plantilla "auth.magic_link".', 'auth.magic_link'], // prettier-ignore
      ['ADMIN_TENANT_SLUG_EXISTS', 'Ya existe un tenant con slug "acme".', 'acme'],
      ['AI_PROVIDERS_PROVIDER_NOT_REGISTERED', 'Provider ollama no registrado.', 'ollama'],
      ['AUTH_API_KEY_MISSING_SCOPES', 'La API key no tiene el/los scope(s) requerido(s): courses:write, users:read', 'courses:write, users:read'], // prettier-ignore
      ['FUNDAE_RLPT_SIZE_INVALID', 'El documento debe pesar entre 1 byte y 5242880 bytes.', '5242880'], // prettier-ignore
      ['MARKETPLACE_ASSET_SURFACE_INVALID', 'Surface "admin-panel" no es válida.', 'admin-panel'],
      ['MARKETPLACE_DISPATCHER_ROUTE_NOT_FOUND', 'No hay módulo registrado para POST /modules/demo', 'POST /modules/demo'], // prettier-ignore
      ['MEMBER_REG_EMAIL_SEND_FAILED', 'No se pudo enviar el email: 550 mailbox unavailable', '550 mailbox unavailable'], // prettier-ignore
      ['MODERATION_REASON_TOO_LONG', 'El motivo no puede pasar de 500 caracteres.', '500'],
      ['MODERATION_SCOPES_UNKNOWN', 'Áreas desconocidas: foro, chat.', 'foro, chat'],
      ['PAYCONN_EMAIL_SEND_FAILED', 'No se pudo enviar el email: 421 too many connections', '421 too many connections'], // prettier-ignore
      ['PAYCONN_PATTERN_INVALID', 'El patrón "[a-" no es una expresión válida.', '[a-'],
      ['SSO_EMAIL_DOMAIN_NOT_ALLOWED', 'El email "ana@otro.com" no pertenece a los dominios permitidos para SSO en este tenant.', 'ana@otro.com'], // prettier-ignore
      ['STORAGE_FILE_SIZE_OUT_OF_RANGE', 'El archivo debe pesar entre 1 byte y 5242880 bytes.', '5242880'], // prettier-ignore
      ['TENANT_MODULES_MODULE_NOT_ACTIVE', 'El módulo "mod.fundae" no está activo para este tenant. Contacta al administrador.', 'mod.fundae'], // prettier-ignore
      ['TENANT_SETTINGS_PARAM_INVALID', 'Parámetro scope inválido', 'scope'],
      ['TENANT_SETTINGS_SMTP_CONFIG_INVALID', 'Config SMTP inválida: host es obligatorio', 'host es obligatorio'], // prettier-ignore
    ];
    for (const [code, backendMessage, detail] of CASOS) {
      const e = httpError(backendMessage, code, detail);
      expect(apiErrorMessage(e, tEs), `${code}: el ES dejó de ser el message crudo`).toBe(
        backendMessage,
      );
      // Y el inglés enseña el MISMO dato, que es el bug que cierra este PR.
      expect(apiErrorMessage(e, tEn), `${code}: el EN se traga el detalle`).toContain(detail);
    }
  });
});

describe('labelOr', () => {
  it('key existente → traducción; ausente → fallback crudo', () => {
    expect(labelOr(tEn, 'mfa_required', 'raw')).toBe(
      'Two-step verification is required to continue.',
    );
    expect(labelOr(tEn, 'no.existe.esto', 'Etiqueta del módulo')).toBe('Etiqueta del módulo');
  });
});
