/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Configuración y datos de la instancia de demostración que se retrata en la
 * documentación.
 *
 * REGLA WHITELABEL (CLAUDE.md §1): aquí no puede entrar ni un dato de un
 * cliente real. Dominios reservados (`example.com`), nombres genéricos
 * (`Academia Demo`, `Admin Demo`, `Alumna Demo`) y credenciales de juguete.
 * Los textos de `didacta-docs` citan estos mismos nombres — si cambias uno,
 * cambia también la página que lo menciona.
 *
 * Los datos son IDÉNTICOS en las dos tandas de idioma a propósito: lo que se
 * traduce es la interfaz, no el contenido que teclea el operador. Así la
 * captura española y la inglesa se diferencian solo en el chrome de la app y
 * se pueden comparar píxel a píxel; y las páginas `.en.md` de la doc, que
 * nombran `Academia Demo` / `Admin Demo` / `Alumna Demo` en inglés, siguen
 * describiendo lo que se ve.
 */

import path from 'node:path';

export type ShotLocale = 'es-ES' | 'en-US';

function resolveLocale(): ShotLocale {
  const raw = (process.env.SHOTS_LOCALE ?? 'es-ES').toLowerCase();
  if (raw.startsWith('en')) return 'en-US';
  return 'es-ES';
}

export const LOCALE: ShotLocale = resolveLocale();

/** `es` | `en` — el catálogo de mensajes que corresponde al locale activo. */
export const CATALOG: 'es' | 'en' = LOCALE.startsWith('en') ? 'en' : 'es';

/** Web (Next). Todas las capturas salen de aquí. */
export const BASE_URL =
  process.env.SHOTS_BASE_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:3010';

/**
 * API. Por defecto se habla con ella a través del rewrite de Next (mismo
 * origen que el navegador), igual que hace el propio frontend.
 */
export const API_URL = process.env.SHOTS_API_URL ?? BASE_URL;

/** UI web de Mailpit — de ahí sale la captura real de la bandeja de entrada. */
export const MAILPIT_URL = process.env.SHOTS_MAILPIT_URL ?? 'http://localhost:8027';

/** Host y puerto SMTP de ese mismo Mailpit, vistos desde la API. */
export const MAILPIT_SMTP_HOST = process.env.SHOTS_MAILPIT_SMTP_HOST ?? 'localhost';
export const MAILPIT_SMTP_PORT = process.env.SHOTS_MAILPIT_SMTP_PORT ?? '1027';

/**
 * Contenedor de Postgres del stack. Solo se usa para aplicar `seed.sql` (los
 * cuatro espacios de sistema de mod.community) sobre el tenant que acaba de
 * crear el asistente, que es exactamente lo que hace `infra/docker/entrypoint.sh`
 * en cada arranque de la imagen. Si no está seteado, ese paso se salta.
 */
export const PG_CONTAINER = process.env.SHOTS_PG_CONTAINER ?? '';
export const PG_USER = process.env.SHOTS_PG_USER ?? 'didacta';
export const PG_DB = process.env.SHOTS_PG_DB ?? 'didacta';

/**
 * Token de un solo uso de `POST /setup/init`. Lo imprime la API en el log al
 * arrancar contra una instancia sin tenants (`SetupTokenService`); el script
 * `reset-instance.sh` lo extrae y lo exporta.
 */
export const SETUP_TOKEN = process.env.SHOTS_SETUP_TOKEN ?? '';

/** Raíz de salida. Un subdirectorio por recorrido; el idioma lo mete `shot()`. */
export const OUT_DIR =
  process.env.SHOTS_OUT_DIR ?? path.resolve(__dirname, '..', '..', 'shots-output');

/** Organización, cuentas y contenido que se ve en las capturas. */
export const DEMO = {
  org: {
    name: 'Academia Demo',
    slug: 'academia-demo',
    /** Sin puerto: `HOSTNAME_RE` del backend no acepta `:`. */
    hostname: 'localhost',
  },
  admin: {
    name: 'Admin Demo',
    email: 'admin@example.com',
    password: 'DidactaDemo2026!',
  },
  alumna: {
    name: 'Alumna Demo',
    email: 'alumna@example.com',
    password: 'AlumnaDemo2026!',
  },
  course: {
    title: 'Introducción a la fotografía digital',
    slug: 'introduccion-a-la-fotografia-digital',
    category: 'Fotografía',
    description:
      'Aprende los fundamentos de la fotografía digital: composición, luz natural y edición básica para empezar a tomar mejores fotos con lo que ya tienes.',
    section: 'Primeros pasos',
    lesson: 'Bienvenida al curso',
    lessonText:
      'Bienvenida o bienvenido. En este curso vas a aprender los fundamentos de la fotografía digital paso a paso: composición, luz y un flujo de edición sencillo. No necesitas equipo profesional para empezar, solo ganas de practicar.',
  },
  smtp: {
    host: MAILPIT_SMTP_HOST,
    port: MAILPIT_SMTP_PORT,
    username: 'notificaciones',
    password: 'mailpit-no-pide-password',
    fromEmail: 'notificaciones@example.com',
    fromName: 'Academia Demo',
  },
  /**
   * Credenciales de Stripe INVENTADAS. Una de las capturas documenta
   * precisamente el error con el que Stripe rechaza una clave inválida, así
   * que el valor tiene que tener forma de clave pero no ser una.
   */
  stripe: {
    secretKey: 'sk_test_00000000000000000000000000000000000000000000000000',
    webhookSecret: 'whsec_0000000000000000000000000000000000000000000000000000',
  },
  accessGroup: {
    name: 'Acceso completo',
  },
  plan: {
    name: 'Suscripción mensual',
    price: '19',
    compareAtPrice: '29',
    trialDays: '7',
  },
  unete: {
    title: 'Fotografía digital, sin límites',
    subtitle: 'Todos los cursos, actualizaciones y comunidad por una cuota mensual.',
  },
} as const;

/**
 * Etiquetas de las anotaciones rojas que NO son copy de la aplicación.
 *
 * Casi todas las anotaciones reutilizan el texto del propio botón (y por tanto
 * se traducen solas leyendo el catálogo de la app). Estas señalan un dato en
 * pantalla, no un control, así que el texto se escribe aquí.
 */
const ANNOTATIONS = {
  es: {
    invitationCode: 'Código de invitación',
    certificateNumber: 'Número de certificado',
    stripeError: 'Stripe rechaza la clave',
  },
  en: {
    invitationCode: 'Invitation code',
    certificateNumber: 'Certificate number',
    stripeError: 'Stripe rejects the key',
  },
} as const;

export function annotationLabel(key: keyof (typeof ANNOTATIONS)['es']): string {
  return ANNOTATIONS[CATALOG][key];
}
