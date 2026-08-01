/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

// ============================================================================
// Plantillas de email que este módulo REGISTRA en el catálogo del core
// (email-template-catalog.ts las agrega a las transaccionales). Los defaults
// reflejan el copy hardcodeado de los composers del host (email-templates.ts
// del host del módulo — hay test que valida la coherencia). Las claves llevan
// el namespace del módulo: `member_registration.*`.
// ============================================================================

/** Variable interpolable de una plantilla ({{name}}). */
export interface ModuleEmailTemplateVariable {
  name: string;
  description: string;
}

/**
 * Entrada de catálogo aportada por el módulo. Estructuralmente compatible con
 * `EmailTemplateCatalogEntry` del core (que la agrega tal cual).
 */
export interface ModuleEmailTemplateDef {
  key: string;
  name: string;
  description: string;
  category: 'members';
  source: 'transactional';
  channels: Array<'EMAIL' | 'IN_APP'>;
  defaultSubject: string | null;
  defaultBody: string;
  variables: ModuleEmailTemplateVariable[];
  structuralNote?: string;
}

export const MEMBER_REGISTRATION_EMAIL_TEMPLATES: ModuleEmailTemplateDef[] = [
  {
    key: 'member_registration.otp_code',
    name: 'Código de acceso (OTP)',
    description: 'Código de un solo uso durante el alta de miembros (verificación de email).',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu código de acceso',
    defaultBody:
      'Tu código de acceso a {{tenantName}} es el que ves abajo.\n\nIntrodúcelo en la pantalla de verificación para continuar. Este código caduca en {{ttlMinutes}} minutos.\n\nSi no has solicitado este acceso, ignora este mensaje.',
    variables: [
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'ttlMinutes', description: 'Minutos de validez del código' },
      { name: 'code', description: 'El código (se muestra también en grande automáticamente)' },
    ],
    structuralNote: 'El código de un solo uso se muestra siempre en grande debajo del texto.',
  },
  {
    key: 'member_registration.approval_request',
    name: 'Nueva inscripción pendiente (al aprobador)',
    description:
      'Aviso al aprobador cuando llega una solicitud de inscripción de miembro pendiente.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Nueva inscripción pendiente — {{name}}',
    defaultBody: 'Hay una nueva inscripción pendiente de tu aprobación en {{tenantName}}.',
    variables: [
      { name: 'name', description: 'Nombre del solicitante' },
      { name: 'email', description: 'Email del solicitante' },
      { name: 'telegramId', description: 'Telegram ID del solicitante' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
    structuralNote:
      'Los datos del solicitante (grupo, impagos, suscripciones, compras) y los botones «Aprobar»/«Rechazar» se añaden siempre después del texto.',
  },
  {
    key: 'member_registration.welcome_approved',
    name: 'Inscripción aprobada (bienvenida)',
    description: 'Cuando el aprobador aprueba la solicitud de inscripción del miembro.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu inscripción en {{tenantName}} ha sido aprobada',
    defaultBody:
      '{{greeting}}\n\n¡Buenas noticias! Tu inscripción en {{tenantName}} ha sido aprobada y tu cuenta ya está activa.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del miembro (puede estar vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'signinUrl', description: 'URL de inicio de sesión' },
    ],
    structuralNote: 'El botón «Entrar» con el enlace de acceso se añade siempre al final.',
  },
  {
    key: 'member_registration.rejection',
    name: 'Inscripción rechazada',
    description: 'Cuando el aprobador rechaza la solicitud de inscripción del miembro.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Sobre tu inscripción en {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\nGracias por tu interés en {{tenantName}}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.\n\nSi crees que se trata de un error, puedes ponerte en contacto con el equipo.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del solicitante (puede estar vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
];
