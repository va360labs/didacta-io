/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { RetentionLocale } from './variables.js';

/**
 * Lo que mod.retention necesita del aula y que NO lee de tablas ajenas
 * (ADR-039, opción B): lo implementa el host con los servicios públicos de cada
 * módulo (mensajería, comunidad) o con lecturas acotadas por `tenantId` de las
 * suyas. Si algún día el módulo se empaqueta aparte, se reescribe este
 * adaptador y el servicio no cambia.
 */

export interface RetentionMember {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  /** Zona IANA del perfil (null o inválida = se usa la del aula). */
  timezone: string | null;
  /** Alta en el aula. */
  joinedAt: Date;
  /** Última vez que usó el aula; null = nunca ha entrado. */
  lastActiveAt: Date | null;
  /** Equipo del aula (formador, administración): nunca recibe mensajes automáticos. */
  isStaff: boolean;
  /**
   * Cuenta traída por una importación (LearnDash, SSO…): su «alta» es la fecha
   * de la importación, no la de su llegada, así que no recibe la bienvenida ni
   * los «a los N días» (una migración de 2.000 personas no son 2.000 altas).
   */
  imported: boolean;
}

export interface RetentionLink {
  title: string;
  url: string;
}

/** Una matrícula vista desde la retención (sin el detalle de lecciones). */
export interface RetentionEnrollmentSignal {
  userId: string;
  courseId: string;
  courseTitle: string;
  courseUrl: string;
  /** Llegó pagando: compra, suscripción o venta externa. */
  paid: boolean;
  enrolledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  progressPercent: number;
  /** Último acceso a una lección del curso. */
  lastActivityAt: Date | null;
}

export interface RetentionAcademy {
  name: string;
  locale: RetentionLocale;
  /** Zona del aula para quien no tiene una válida en el perfil. */
  timezone: string | null;
  /** Dirección pública del aula, sin barra final. */
  webBaseUrl: string;
  /** Dónde presentarse a la comunidad. */
  introUrl: string;
  communityUrl: string;
  /** Catálogo de cursos (respaldo de `{enlace_curso}` si no hay ninguno). */
  coursesUrl: string;
}

export interface RetentionStaffMember {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface RetentionReceipt {
  conversationId: string;
  userId: string;
  /** Hasta dónde ha leído la persona esa conversación. */
  lastReadAt: Date | null;
  /** Primer mensaje suyo en la conversación desde `since`. */
  repliedAt: Date | null;
}

export interface RetentionPorts {
  academy(tenantId: string): Promise<RetentionAcademy>;
  /** Cuentas ACTIVAS y no eliminadas del aula, equipo incluido (marcado). */
  listMembers(tenantId: string): Promise<RetentionMember[]>;
  /** Las mismas, solo de esos ids (las que no existen o no están activas no vuelven). */
  getMembers(tenantId: string, ids: string[]): Promise<RetentionMember[]>;
  /** Equipo del aula que puede firmar los mensajes, primero quien lo administra. */
  listStaff(tenantId: string): Promise<RetentionStaffMember[]>;
  isModuleEnabled(tenantId: string, moduleName: string): Promise<boolean>;
  /** Matrículas activas o terminadas (de todo el aula o de esas personas). */
  enrollmentSignals(tenantId: string, userIds?: string[]): Promise<RetentionEnrollmentSignal[]>;
  firstPublishedCourse(tenantId: string): Promise<RetentionLink | null>;
  courseLink(tenantId: string, courseId: string): Promise<RetentionLink | null>;
  /** Nivel actual de la persona (para la vista previa de «subida de nivel»). */
  levelName(tenantId: string, userId: string): Promise<string | null>;
  /** Quién ha pagado algo en el aula y cuándo fue el primer pago. */
  paidAccess(tenantId: string): Promise<Array<{ userId: string; paidAt: Date }>>;
  /** Inicio de la suscripción o membresía vigente de cada persona. */
  subscriptionStarts(tenantId: string): Promise<Array<{ userId: string; startedAt: Date }>>;
  isFirstPost(tenantId: string, authorId: string, postId: string): Promise<boolean>;
  /** Mensaje directo de `senderId` a `toUserId`, con su push en tiempo real. */
  sendDirectMessage(
    tenantId: string,
    senderId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string; messageId: string }>;
  /** Mensajes directos que alguien de `authorIds` le ha escrito desde `since`. */
  recentDirectMessages(
    tenantId: string,
    authorIds: string[],
    toUserId: string,
    since: Date,
  ): Promise<Array<{ messageId: string; createdAt: Date }>>;
  /** Uno por cada elemento de `items`, en el MISMO orden. */
  receipts(
    tenantId: string,
    items: Array<{ conversationId: string; userId: string; since: Date }>,
  ): Promise<RetentionReceipt[]>;
  /**
   * Correo con la marca del aula. El host respeta la baja de los correos de la
   * comunidad y la preferencia «Comunidad · Email» de la persona, y añade el
   * enlace de baja; devuelve por qué no salió si no salió.
   */
  sendEmail(
    tenantId: string,
    toUserId: string,
    message: { subject: string; body: string },
  ): Promise<RetentionEmailOutcome>;
}

export type RetentionEmailOutcome = 'sent' | 'opted_out' | 'preference_off' | 'no_address';
