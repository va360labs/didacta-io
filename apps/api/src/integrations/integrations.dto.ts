/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import type { CourseOfferOption } from '@didacta/mod-billing';

/**
 * Contratos de LECTURA para integradores externos (`/api/v1/integrations`).
 *
 * Los consume un sitio de terceros —típicamente un WordPress— que quiere
 * pintar la ficha de un curso con datos de Didacta en vez de con los de su
 * propio LMS. Son de solo lectura y NUNCA exponen el `content` de una lección:
 * el temario se enseña para vender, la clase se da en Didacta.
 */

/** Filtros de `GET /integrations/courses`. Sin ninguno, devuelve el catálogo entero. */
export const listCoursesQuerySchema = z.object({
  /** Slug exacto del curso en Didacta. */
  slug: z.string().trim().min(1).max(200).optional(),
  /**
   * Id del curso en el sistema de origen cuando fue importado (ej. el ID del
   * post de WordPress si vino por mod.migrator-learndash). Junto con
   * `externalSource` permite al integrador resolver el mapeo sin copiar UUIDs.
   */
  externalId: z.string().trim().min(1).max(200).optional(),
  externalSource: z.string().trim().min(1).max(40).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
});
export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;

/** Query de `GET /integrations/learners/state`. */
export const learnerStateQuerySchema = z.object({
  /** Email del usuario en el sitio externo. Se busca dentro del tenant de la API key. */
  email: z.string().trim().email().max(320),
  /** Si se indica, la respuesta añade el detalle de progreso en ese curso. */
  courseId: z.string().uuid().optional(),
});
export type LearnerStateQuery = z.infer<typeof learnerStateQuerySchema>;

/**
 * Cuántos alumnos han pasado por un curso. Es el dato que una página de venta
 * enseña como prueba social ("860 alumnos"), y por eso van los dos números:
 * publicar el activo como si fuera el histórico encoge la cifra cada vez que
 * alguien cancela.
 */
export interface IntegrationEnrollmentTotals {
  /**
   * HISTÓRICO: toda matrícula que ha existido en el curso, incluidas las
   * canceladas y las suspendidas. Es el "han pasado por aquí" de una ficha de
   * venta.
   */
  enrollments: number;
  /**
   * Los que pueden entrar a clase hoy (ACTIVE o COMPLETED). Sirve para
   * informes; para vender, casi siempre se quiere el de arriba.
   */
  enrollmentsActive: number;
}

/** Curso en la lista de mapeo. Lo justo para que el integrador elija y guarde el UUID. */
export interface IntegrationCourseSummary {
  id: string;
  slug: string;
  title: string;
  /** DRAFT | PUBLISHED | ARCHIVED. Solo los PUBLISHED se venden y admiten matrícula. */
  status: string;
  category: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  /** Origen de la importación (ej. "learndash") y su id allí. Null si el curso nació en Didacta. */
  externalSource: string | null;
  externalId: string | null;
  totals: IntegrationEnrollmentTotals;
}

/**
 * Totales de TODO el tenant, no de los cursos filtrados. Van en el sobre de la
 * lista porque no son la suma de los cursos: quien está matriculado en tres
 * cuenta una vez. Es el número de la portada ("+3.000 alumnos formados"), que
 * sumando fichas sale inflado.
 */
export interface IntegrationTenantTotals {
  /** Personas distintas con al menos una matrícula, de cualquier estado. */
  learners: number;
  /** Matrículas totales del tenant, histórico. `learners` <= `enrollments`. */
  enrollments: number;
}

/** Respuesta de `GET /integrations/courses`. */
export interface IntegrationCourseListResponse {
  courses: IntegrationCourseSummary[];
  /** Del tenant entero: NO se ve afectado por los filtros de la query. */
  tenantTotals: IntegrationTenantTotals;
}

/** Lección tal y como se muestra en un temario público: sin contenido. */
export interface IntegrationLesson {
  id: string;
  title: string;
  /** VIDEO | HTML | PDF | TEXT | QUIZ | SCORM. */
  type: string;
  position: number;
  durationMinutes: number | null;
  /**
   * La lección tiene fecha de publicación futura (drip por fecha fija): existe
   * en el temario pero todavía no se puede abrir. El drip relativo por tier o
   * grupo NO se refleja aquí porque depende de cada alumno.
   */
  scheduled: boolean;
}

export interface IntegrationModule {
  id: string;
  title: string;
  description: string | null;
  position: number;
  lessons: IntegrationLesson[];
}

/** Quién imparte el curso, para el bloque de autor de la ficha de venta. */
export interface IntegrationInstructor {
  name: string | null;
  jobTitle: string | null;
  avatarUrl: string | null;
}

/** Ficha completa de un curso para pintarla fuera de Didacta. */
export interface IntegrationCourseDetail extends IntegrationCourseSummary {
  description: string | null;
  featuredVideoUrl: string | null;
  language: string;
  /** Duración anunciada del curso, la que puso el formador. Puede no cuadrar con `totals.minutes`. */
  estimatedMinutes: number | null;
  /** Página de venta externa configurada en el curso, si la hay. */
  externalPurchaseUrl: string | null;
  /** El curso emite certificado al completarlo. */
  hasCertificate: boolean;
  instructor: IntegrationInstructor | null;
  totals: IntegrationEnrollmentTotals & {
    modules: number;
    lessons: number;
    /**
     * Suma real de las duraciones de las lecciones. **0 si ninguna la
     * declara**, que es lo normal: `durationMinutes` es un campo opcional que
     * el formador rellena clase a clase. Un 0 aquí significa "el curso no lo
     * tiene cargado", no "dura cero" — no lo publiques como dato.
     */
    minutes: number;
  };
  modules: IntegrationModule[];
  /**
   * Oferta de compra en mod.billing. `forSale: false` cuando el curso no tiene
   * precio configurado en Didacta — lo normal si se vende en la tienda externa.
   */
  offer: { forSale: boolean; options: CourseOfferOption[] };
}

/** Una matrícula del alumno, en resumen. */
export interface IntegrationLearnerEnrollment {
  courseId: string;
  courseTitle: string | null;
  courseSlug: string | null;
  /** ACTIVE | COMPLETED | PAUSED | CANCELLED. */
  status: string;
  /** ADMIN | CODE | INVITATION_LINK | PURCHASE | IMPORT | SUBSCRIPTION | API | GROUP. */
  source: string;
  progressPercent: number;
  enrolledAt: string;
  completedAt: string | null;
}

/** Por dónde sigue el alumno, con el enlace directo a la clase. */
export interface IntegrationNextLesson {
  id: string;
  title: string;
  moduleId: string;
  moduleTitle: string;
  /** URL absoluta a la lección en Didacta. Pide login si no hay sesión. */
  url: string;
}

/** Detalle del alumno en UN curso concreto. Solo si se pidió con `courseId`. */
export interface IntegrationLearnerCourseState {
  courseId: string;
  /** Hay matrícula y no está cancelada. */
  enrolled: boolean;
  /**
   * Puede entrar a las clases AHORA (ACTIVE o COMPLETED). `false` con
   * `status: 'PAUSED'` significa suspendido —típicamente por impago—, no
   * "nunca compró": el progreso sigue intacto.
   */
  hasAccess: boolean;
  status: string | null;
  progressPercent: number;
  lessonsCompleted: number;
  lessonsTotal: number;
  completedLessonIds: string[];
  /** Primera lección sin completar, o la primera del curso. Null si el curso está vacío. */
  nextLesson: IntegrationNextLesson | null;
}

/**
 * La membresía viva del alumno, si la tiene.
 *
 * Existe para una pregunta muy concreta: una tienda externa que también vende
 * la membresía necesita saber, ANTES de cobrar, si esta persona ya la tiene.
 * Sin esto la misma persona acaba con dos suscripciones corriendo a la vez y un
 * solo acceso, y el segundo cobro no lo detecta nadie hasta que llega el recibo.
 *
 * Solo aparecen las membresías **vivas** (`TRIALING`, `ACTIVE`, `PAST_DUE`). Una
 * cancelada o impagada no se devuelve: esa persona sí puede volver a contratar,
 * y es justo a quien se le quiere vender.
 */
export interface IntegrationLearnerMembership {
  /** `TRIALING` (prueba en curso), `ACTIVE`, o `PAST_DUE` (impago en gracia). */
  status: string;
  /** Plan contratado. `null` solo si el plan se borró después de venderse. */
  planId: string | null;
  planName: string | null;
  /** `month` | `year`, como el price de Stripe. */
  interval: string;
  /** Importe del periodo actual en céntimos. */
  amountCents: number;
  currency: string;
  /** Cuándo vuelve a cobrarse (o cuándo caduca si está cancelándose). */
  currentPeriodEnd: string | null;
  /** Pidió la baja: sigue con acceso hasta `currentPeriodEnd` y no renueva. */
  cancelAtPeriodEnd: boolean;
}

/** Respuesta de `GET /integrations/learners/state`. */
export interface IntegrationLearnerState {
  /**
   * Existe un usuario con ese email en el tenant. `false` = visitante para
   * Didacta; el integrador debe pintar el bloque en modo venta.
   */
  known: boolean;
  userId: string | null;
  name: string | null;
  enrollments: IntegrationLearnerEnrollment[];
  course: IntegrationLearnerCourseState | null;
  /**
   * Membresía viva, o `null`. **`null` no significa "puede comprar sin más"**
   * si la membresía se vende también fuera de Didacta: aquí solo se ve lo que
   * se contrató en el aula.
   */
  membership: IntegrationLearnerMembership | null;
}

// ============================================================================
// Compras hechas fuera (`/integrations/orders`)
// ----------------------------------------------------------------------------
// El único trozo de ESCRITURA de esta API. Existe porque una tienda externa que
// vende cursos deja al alumno con las clases en un sitio y su historial de
// compra en otro, y esa segunda pantalla acaba construida dos veces.
//
// Lo que se guarda es el PEDIDO, no la contabilidad: Didacta no emite facturas
// ni numera series fiscales. De la factura viajan su número, su fecha y un
// enlace al PDF que sirve quien la emitió.
// ============================================================================

/**
 * Una línea del pedido, tal y como se vendió.
 *
 * `courseId` es opcional y suele faltar: un pack, una mentoría o un servicio no
 * son un curso del aula. Cuando está, el perfil puede enlazar la compra con la
 * clase.
 */
export const externalOrderLineSchema = z.object({
  name: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(1000).default(1),
  /** En la unidad mínima de la moneda (céntimos en EUR). Puede ser 0: un regalo. */
  amountCents: z.number().int().min(0).max(100_000_000),
  courseId: z.string().uuid().optional(),
});
export type ExternalOrderLine = z.infer<typeof externalOrderLineSchema>;

/**
 * La factura, si ya se emitió.
 *
 * Va en su propio objeto y es OPCIONAL porque casi nunca se emite en el mismo
 * instante del cobro: lo normal es cobrar, mandar el pedido, y volver minutos u
 * horas después con el número. **Omitirla no borra la que ya hubiera** — así el
 * reintento de un webhook no deja al alumno sin su factura.
 */
export const externalOrderInvoiceSchema = z.object({
  number: z.string().trim().min(1).max(60),
  issuedAt: z.string().datetime().optional(),
  /** URL absoluta al PDF. Didacta no guarda el documento, solo por dónde se pide. */
  url: z.string().url().max(2000).optional(),
});

/** Cuerpo de `POST /integrations/orders`. */
export const upsertExternalOrderSchema = z.object({
  /** El comprador. Si todavía no existe en el aula, el pedido se guarda igual. */
  email: z.string().trim().email().max(320),
  /**
   * Quién vendió (`va360.academy`). Junto con `reference` es la clave de
   * idempotencia: el mismo par actualiza la fila en vez de duplicarla.
   */
  source: z.string().trim().min(1).max(60),
  /** El número de pedido EN LA TIENDA. No es un número de factura. */
  reference: z.string().trim().min(1).max(100),
  status: z.enum(['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED']).default('PAID'),
  /** Total cobrado en la unidad mínima de la moneda. Entero: el dinero no es un float. */
  amountCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().trim().length(3).toLowerCase().default('eur'),
  /** Cuándo se compró. Sin esto, un histórico migrado se ordenaría por cuándo se copió. */
  placedAt: z.string().datetime(),
  refundedAt: z.string().datetime().optional(),
  lines: z.array(externalOrderLineSchema).max(100).default([]),
  invoice: externalOrderInvoiceSchema.optional(),
  /** El pedido en la tienda, para el botón «verlo allí». */
  orderUrl: z.string().url().max(2000).optional(),
});
export type UpsertExternalOrderDto = z.infer<typeof upsertExternalOrderSchema>;

/** Query de `GET /integrations/learners/orders`. */
export const learnerOrdersQuerySchema = z.object({
  email: z.string().trim().email().max(320),
  /** Solo los de una tienda concreta. Un tenant puede tener más de una. */
  source: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LearnerOrdersQuery = z.infer<typeof learnerOrdersQuerySchema>;

/** Un pedido tal y como sale de la API. */
export interface IntegrationExternalOrder {
  id: string;
  source: string;
  reference: string;
  /** PAID | REFUNDED | PARTIALLY_REFUNDED | CANCELLED. */
  status: string;
  amountCents: number;
  currency: string;
  lines: ExternalOrderLine[];
  invoice: { number: string; issuedAt: string | null; url: string | null } | null;
  orderUrl: string | null;
  placedAt: string;
  refundedAt: string | null;
  /**
   * El pedido está atado a una cuenta del aula. `false` = llegó antes de que
   * existiera y se sigue localizando por el correo. No es un error.
   */
  linkedToUser: boolean;
}

/** Respuesta de `GET /integrations/learners/orders`. */
export interface IntegrationLearnerOrders {
  /** Mismo significado que en `learners/state`: ese email existe en el tenant. */
  known: boolean;
  userId: string | null;
  /**
   * Sus compras, de la más reciente a la más antigua. **`known: false` no
   * implica lista vacía**: una tienda puede haber mandado el pedido antes de
   * que `/inscribe` creara la cuenta.
   */
  orders: IntegrationExternalOrder[];
}
