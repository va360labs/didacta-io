import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage, CODES_WITH_DETAIL, CODES_WITH_PARAMS } from './api-error';
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

  it('el catálogo ES rinde byte a byte el `message` de los errores de modules/**', () => {
    // Los 75 codes que este PR cierra viven en las clases de error de
    // `modules/<mod>/src/errors.ts` (shape `super(msg, CODE)`), que ningún
    // barrido anterior miraba porque solo buscaban `code: 'X'` en
    // `apps/api/src`.
    //
    // Los mensajes de la tabla NO salen del catálogo —eso sería tautológico—:
    // son el `message` que compone el `super(...)` del backend, con el valor
    // interpolado sustituido por el centinela. Si alguien cambia el copy español
    // del backend y no toca el catálogo (o al revés), la igualdad se rompe aquí.
    const DATO = 'DATO-1';
    const CASOS: ReadonlyArray<readonly [string, string]> = [
      ['AI_CONTENT_DRAFT_NOT_FOUND', 'Draft no encontrado: DATO-1'],
      [
        'AI_CONTENT_LESSON_TEXT_EMPTY',
        'La lección DATO-1 no tiene texto extraíble. La IA necesita contenido textual para generar.',
      ],
      [
        'AI_CONTENT_PROVIDER_ERROR',
        'El proveedor IA falló al generar contenido: DATO-1. Revisa la config del tenant.',
      ],
      [
        'AI_GRADER_ATTEMPT_NOT_PENDING',
        'El attempt DATO-1 no está en estado PENDING_REVIEW; AI Grader solo sugiere notas para attempts pendientes de corrección.',
      ],
      ['AI_GRADER_RESPONSE_PARSE_ERROR', 'No pudimos parsear la respuesta del modelo: DATO-1'],
      ['AI_GRADER_RUBRIC_INVALID', 'Rúbrica inválida: DATO-1'],
      [
        'AI_GRADER_RUBRIC_NOT_FOUND',
        'No hay rúbrica configurada para la pregunta DATO-1. El formador debe crear una antes de pedir sugerencias IA.',
      ],
      ['AI_GRADER_SUGGESTION_NOT_FOUND', 'Sugerencia DATO-1 no encontrada en este tenant.'],
      ['AI_TUTOR_CORRECTION_NOT_FOUND', 'No existe la corrección DATO-1.'],
      [
        'AI_TUTOR_COURSE_ACCESS_DENIED',
        'Sin acceso al curso DATO-1: el tutor sólo responde sobre cursos en los que estás matriculado.',
      ],
      [
        'AI_TUTOR_COURSE_NOT_INDEXED',
        'El curso DATO-1 no está indexado todavía. Publica el curso o solicita re-indexación al admin.',
      ],
      [
        'AI_TUTOR_COURSE_NOT_PUBLISHED',
        'El curso DATO-1 no está publicado; el tutor IA solo opera sobre cursos publicados.',
      ],
      ['AI_TUTOR_MESSAGE_NOT_FOUND', 'No existe la respuesta DATO-1 del tutor en este tenant.'],
      ['BILLING_ORDER_NOT_FOUND', 'Orden no encontrada: DATO-1'],
      [
        'BILLING_PRODUCT_ALREADY_EXISTS',
        'Ya existe un producto activo para el curso DATO-1. Edita el existente o desactívalo antes de crear uno nuevo.',
      ],
      ['BILLING_PRODUCT_INACTIVE', 'El producto del curso DATO-1 está desactivado.'],
      ['BILLING_PRODUCT_NOT_FOUND', 'Producto no encontrado: DATO-1'],
      ['BILLING_STRIPE_API_ERROR', 'Error de Stripe API: DATO-1'],
      ['BILLING_STRIPE_CONFIG_MISSING', 'Configuración Stripe incompleta: falta DATO-1.'],
      ['BILLING_WEBHOOK_SIGNATURE_INVALID', 'Firma del webhook inválida: DATO-1'],
      ['COURSE_ALREADY_PUBLISHED', 'El curso DATO-1 ya está publicado'],
      ['COURSE_SLUG_EXISTS', 'Ya existe un curso con slug "DATO-1" en este tenant'],
      ['FUNDAE_ACTION_NOT_FOUND', 'La acción formativa DATO-1 no existe.'],
      [
        'FUNDAE_ACTION_WITHOUT_COURSE',
        'La acción DATO-1 no tiene curso vinculado; no es posible generar evidencias por participante.',
      ],
      ['FUNDAE_BLOCK_NOT_FOUND', 'El módulo formativo DATO-1 no existe.'],
      ['FUNDAE_BLOCK_ORDINAL_DUPLICADO', 'Ya existe un bloque con ordinal DATO-1 en esta acción.'],
      [
        'FUNDAE_CODIGO_DUPLICADO',
        'Ya existe una acción formativa con código "DATO-1" en este tenant.',
      ],
      [
        'FUNDAE_COMPANY_NIF_DUPLICADO',
        'Ya existe una empresa bonificada con NIF "DATO-1" en este tenant.',
      ],
      ['FUNDAE_COMPANY_NOT_FOUND', 'La empresa bonificada DATO-1 no existe.'],
      ['FUNDAE_COST_NOT_FOUND', 'El coste DATO-1 no existe.'],
      ['FUNDAE_COURSE_NOT_IN_TENANT', 'El curso DATO-1 no pertenece a este tenant.'],
      [
        'FUNDAE_GROUP_CERRADO',
        'El grupo DATO-1 está cerrado: no se pueden modificar costes ni metadatos.',
      ],
      ['FUNDAE_GROUP_NOT_FOUND', 'El grupo bonificable DATO-1 no existe.'],
      ['FUNDAE_GROUP_NUMERO_DUPLICADO', 'Ya existe un grupo con número DATO-1 en esta acción.'],
      ['FUNDAE_GROUP_PARTICIPANT_NOT_FOUND', 'La matriculación DATO-1 no existe.'],
      [
        'FUNDAE_GROUP_SIN_CURSO',
        'El grupo DATO-1 pertenece a una acción sin curso vinculado; no se puede hacer bulk-enroll desde el catálogo. Añade los participantes uno a uno.',
      ],
      [
        'FUNDAE_PARTICIPANT_NOT_IN_ACTION',
        'El usuario DATO-1 no está matriculado en el curso vinculado a esta acción.',
      ],
      [
        'FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING',
        'La empresa DATO-1 no tiene una notificación inicial a la RLPT registrada; no se puede iniciar un grupo bonificable hasta hacerla y subir la evidencia.',
      ],
      ['FUNDAE_RLPT_NOT_FOUND', 'La notificación RLPT DATO-1 no existe.'],
      ['INVITATION_INVALID', 'Invitación inválida: DATO-1'],
      ['MAX_ATTEMPTS_REACHED', 'El alumno ha alcanzado el máximo de intentos permitidos (DATO-1)'],
      ['MEMBERSHIP_CONFIG_INCOMPLETE', 'Membresía mal configurada: DATO-1'],
      [
        'MEMBERSHIP_PLAN_INTERVAL_INVALID',
        'Periodicidad inválida: DATO-1 meses. Usa un entero entre 1 y 12 (Stripe no admite periodos de facturación de más de un año).',
      ],
      ['MEMBERSHIP_PLAN_NOT_FOUND', 'Plan de membresía no encontrado o inactivo: DATO-1'],
      ['MESSAGING_SPACE_NOT_FOUND', 'El espacio "DATO-1" no existe.'],
      [
        'PAYMENT_CONNECTIONS_ALREADY_EXISTS',
        'Ya existe una conexión Stripe con el nombre "DATO-1". Usa un nombre distinto.',
      ],
      ['PAYMENT_CONNECTIONS_NOT_FOUND', 'Conexión de pago no encontrada: DATO-1'],
      [
        'PAYMENT_CONNECTIONS_PORTAL_UNAVAILABLE',
        'El proveedor "DATO-1" no ofrece un portal de gestión de suscripción integrado.',
      ],
      [
        'PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED',
        'Proveedor de pago no soportado: "DATO-1". En esta versión solo se soporta "stripe" (PayPal en roadmap).',
      ],
      ['PAYMENT_CONNECTIONS_STRIPE_API_ERROR', 'Error leyendo de la cuenta de pago: DATO-1'],
      [
        'PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID',
        'Credencial de la cuenta de pago inválida o sin permiso de lectura: DATO-1',
      ],
      ['PAYMENT_CONNECTIONS_TIER_NAME_CONFLICT', 'Ya existe un tier con el nombre "DATO-1".'],
      ['PAYMENT_CONNECTIONS_TIER_NOT_FOUND', 'Tier no encontrado: DATO-1'],
      ['REFERRALS_COMMISSION_NOT_FOUND', 'Comisión no encontrada: DATO-1'],
      ['SCORM_PACKAGE_INVALID', 'Paquete SCORM inválido: DATO-1'],
      ['SPACE_EXISTS', "Ya existe un espacio con slug 'DATO-1'."],
      ['SPACE_NOT_FOUND', "El espacio 'DATO-1' no existe o no pertenece al tenant"],
      [
        'SUBSCRIPTIONS_ALREADY_ACTIVE',
        'Ya tienes una suscripción activa para el curso DATO-1. Cancela la actual antes de crear otra.',
      ],
      ['SUBSCRIPTIONS_NOT_FOUND', 'Suscripción no encontrada: DATO-1'],
      [
        'SUBSCRIPTIONS_PRICE_NOT_RECURRING',
        'El price DATO-1 no es recurring. mod.subscriptions sólo acepta prices recurring (interval=month|year). Para pago único usa mod.billing.',
      ],
      ['SUBSCRIPTIONS_STRIPE_API_ERROR', 'Error de Stripe API: DATO-1'],
      ['SUBSCRIPTIONS_STRIPE_CONFIG_MISSING', 'Configuración Stripe incompleta: falta DATO-1.'],
      ['SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID', 'Firma del webhook inválida: DATO-1'],
      ['TAG_NAME_EXISTS', 'Ya existe un tag llamado "DATO-1" en este tenant'],
      ['TAG_NOT_FOUND', 'El tag DATO-1 no existe o no pertenece al tenant'],
      ['TEMPLATE_IN_USE', 'No se puede eliminar: DATO-1 curso(s) están usando esta plantilla.'],
      ['TEMPLATE_NAME_TAKEN', 'Ya existe una plantilla con nombre "DATO-1" en este tenant.'],
      [
        'THEMING_CUSTOM_CSS_TOO_LARGE',
        'El CSS personalizado excede el máximo permitido de DATO-1 bytes.',
      ],
      ['THEMING_CUSTOM_CSS_UNSAFE', 'El CSS personalizado contiene código no permitido: DATO-1.'],
      [
        'THEMING_FOOTER_HTML_TOO_LARGE',
        'El HTML del footer excede el máximo permitido de DATO-1 bytes.',
      ],
      ['THEMING_INVALID_URL', 'La URL de "DATO-1" no es válida o no usa https.'],
      ['THEMING_LOGO_TOO_LARGE', 'El logo excede el máximo permitido de DATO-1 MB.'],
      ['ZOOM_API_ERROR', 'Error hablando con Zoom: DATO-1'],
      ['ZOOM_COURSE_NOT_IN_TENANT', 'El curso DATO-1 no pertenece a este tenant.'],
      [
        'ZOOM_HOST_NOT_FOUND',
        'El email del host (DATO-1) no es un usuario de vuestra cuenta de Zoom, así que Zoom no deja crear la reunión a su nombre. Usa el email de alguien que tenga usuario en la cuenta de Zoom, o añádelo primero desde zoom.us → Gestión de usuarios.',
      ],
    ];
    // Guarda de cobertura: un code nuevo con {detail} en modules/** que no entre
    // en la tabla no tendría prueba de que el ES no cambia.
    expect(CASOS.length, 'la tabla dejó de cubrir los codes de modules/**').toBe(75);
    for (const [code, backendMessage] of CASOS) {
      expect(CODES_WITH_DETAIL.has(code), `${code} no está en CODES_WITH_DETAIL`).toBe(true);
      const e = httpError(backendMessage, code, DATO);
      expect(apiErrorMessage(e, tEs), `${code}: el ES dejó de ser el message crudo`).toBe(
        backendMessage,
      );
      // El bug que cierra el PR: el inglés se tragaba el dato.
      expect(apiErrorMessage(e, tEn), `${code}: el EN se traga el detalle`).toContain(DATO);
      // …y la salida fácil (borrar la key EN) pintaría el español crudo.
      expect(apiErrorMessage(e, tEn), `${code}: el EN sigue pintando el español`).not.toBe(
        backendMessage,
      );
    }
  });
});

// ============================================================================
// Codes cuyo `message` interpola DOS o más valores con copy español entre
// medias (`ApiError.params`). El bug que cierran: con un `detail` único, el
// inglés heredaba el conector español — «The AI provider failed: openai falló:
// timeout» — así que colapsarlos MOVÍA el bug en vez de arreglarlo.
// ============================================================================
describe('apiErrorMessage con placeholders con nombre', () => {
  function withParams(
    message: string,
    code: string,
    params?: Record<string, string>,
  ): ApiHttpError {
    return new ApiHttpError({ message, status: 502, code, params });
  }

  it('el catálogo ES rinde byte a byte el `message` del backend, y el EN no hereda su gramática', () => {
    // Los `message` NO salen del catálogo (sería tautológico): son los que
    // componen los `super(...)` del backend con los valores ya interpolados.
    const CASOS: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
      [
        'AI_GRADER_PROVIDER_ERROR',
        'Provider openai falló: timeout tras 30s',
        { provider: 'openai', reason: 'timeout tras 30s' },
      ],
      [
        'AI_TUTOR_CHAT_PROVIDER_ERROR',
        'Provider anthropic falló: 429 rate limited',
        { provider: 'anthropic', reason: '429 rate limited' },
      ],
      [
        'AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR',
        'Provider voyage falló: connection reset',
        { provider: 'voyage', reason: 'connection reset' },
      ],
      [
        'AI_PROVIDER_UNAVAILABLE',
        'openai respondió 503: upstream connect error',
        { provider: 'openai', statusCode: '503', body: 'upstream connect error' },
      ],
      [
        'AI_CONTENT_INVALID_JSON',
        'El JSON propuesto para draft tipo QUIZ no es válido: falta el campo questions.',
        { type: 'QUIZ', reason: 'falta el campo questions' },
      ],
    ];
    expect(CASOS.length, 'la tabla dejó de cubrir CODES_WITH_PARAMS').toBe(CODES_WITH_PARAMS.size);
    for (const [code, backendMessage, params] of CASOS) {
      const e = withParams(backendMessage, code, params);
      expect(apiErrorMessage(e, tEs), `${code}: el ES dejó de ser el message crudo`).toBe(
        backendMessage,
      );
      const english = apiErrorMessage(e, tEn);
      for (const value of Object.values(params)) {
        expect(english, `${code}: el EN se traga ${value}`).toContain(value);
      }
      // El bug que MOVERÍA un `detail` único: el conector español dentro del
      // inglés. Ninguno de los tres aparece en la frase inglesa.
      for (const conector of [' falló:', ' respondió ', ' no es válido:']) {
        expect(english, `${code}: el EN hereda el conector español`).not.toContain(conector);
      }
      expect(english, `${code}: el EN sigue pintando el español`).not.toBe(backendMessage);
      expect(english, `${code}: pinta la key`).not.toContain(code);
    }
  });

  it('un statusCode numérico NO se formatea con separador de miles', () => {
    // Va como string a propósito: con un número, ICU lo formatearía por idioma
    // y el ES dejaría de rendir byte a byte el `message` del backend.
    const e = withParams('openai respondió 1234: x', 'AI_PROVIDER_UNAVAILABLE', {
      provider: 'openai',
      statusCode: '1234',
      body: 'x',
    });
    expect(apiErrorMessage(e, tEs)).toBe('openai respondió 1234: x');
    expect(apiErrorMessage(e, tEn)).toContain('1234');
    expect(apiErrorMessage(e, tEn)).not.toContain('1.234');
  });

  it('CAMINO DEGRADADO: params ausente, incompleto o en blanco → message crudo', () => {
    const message = 'Provider openai falló: timeout';
    const PARCIALES: ReadonlyArray<Record<string, string> | undefined> = [
      undefined,
      {},
      { provider: 'openai' },
      { provider: 'openai', reason: '   ' },
      { reason: 'timeout' },
    ];
    for (const params of PARCIALES) {
      const e = withParams(message, 'AI_GRADER_PROVIDER_ERROR', params);
      const rendered = apiErrorMessage(e, tEn);
      expect(rendered, `params=${JSON.stringify(params)}`).toBe(message);
      expect(rendered).not.toContain('AI_GRADER_PROVIDER_ERROR');
    }
  });

  it('los dos catálogos interpolan TODOS los placeholders declarados', () => {
    // Recorre la lista REAL: añadir un code y olvidar una traducción (o
    // escribir otro nombre de placeholder) rompe aquí, no en producción.
    const CATALOGOS: ReadonlyArray<readonly [string, TranslatorLike]> = [
      ['es', tEs],
      ['en', tEn],
    ];
    for (const [code, names] of CODES_WITH_PARAMS) {
      for (const [locale, t] of CATALOGOS) {
        expect(t.has(code), `${locale}: falta la key ${code} en el catálogo`).toBe(true);
        const values = Object.fromEntries(names.map((n, i) => [n, `ZZ${i}`]));
        const text = t(code, values);
        for (const centinela of Object.values(values)) {
          expect(text, `${locale}/${code} no interpola ${centinela}`).toContain(centinela);
        }
        // La key cruda en pantalla es el síntoma de un ICU que no resolvió (la
        // trampa de las comillas simples alrededor de un placeholder).
        expect(text, `${locale}/${code} pinta la key`).not.toContain(code);
        expect(text, `${locale}/${code} deja un placeholder crudo`).not.toMatch(/\{[a-zA-Z]/);
      }
    }
  });

  it('CODES_WITH_PARAMS y CODES_WITH_DETAIL no comparten ningún code', () => {
    // Un code manda UN dato anónimo o VARIOS con nombre. `apiErrorMessage` mira
    // `params` primero, así que estar en las dos dejaría el `{detail}` sin
    // rellenar en silencio.
    for (const code of CODES_WITH_PARAMS.keys()) {
      expect(CODES_WITH_DETAIL.has(code), `${code} está en las dos listas`).toBe(false);
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
