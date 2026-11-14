/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import {
  CourseHasNoLessonsError,
  CourseSlugAlreadyExistsError,
  CourseAlreadyPublishedError,
} from '@didacta/mod-courses';
import { SpaceAlreadyExistsError } from '@didacta/mod-community';
import { PrismaService } from '../prisma/prisma.service';
import {
  academyLocale,
  writeAcademyLocale,
  type AcademyDefaultsPrisma,
  type AcademyLocaleWriter,
} from '../common/academy-defaults';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantStripeResolverService } from '../modules/tenant-stripe-resolver.service';
import { PlatformCheckoutGate } from '../modules/payouts/platform-checkout-gate';
import { DEFAULT_CARD_FEE_ESTIMATE } from '../modules/payouts/platform-payments.config';
import {
  SimpleModeError,
  emptyOfferIntent,
  lessonHasContent,
  OWN_KEYS_CURRENCIES,
  PLATFORM_CURRENCIES,
  STEP_IDS,
  textsFor,
  toCourseSlug,
  type CourseSaleView,
  type OfferIntent,
  type PriceFeesView,
  type QuickStartInput,
  type SimpleLocale,
  type StartHereView,
  type StepId,
} from './simple-mode.model';

/** Namespace de `tenant_setting` donde vive el estado del modo sencillo. */
export const SIMPLE_MODE_SETTINGS_SCOPE = 'simple-mode';
const OFFER_KEY = 'offer';
const STATE_KEY = 'state';

/** Estado auxiliar: lo que el creador confirmó a mano (sin rastro en otras tablas). */
interface SimpleModeState {
  /** Pulsó «Guardar» en «Tu academia» aunque no cambiara logo ni color. */
  academyConfirmedAt?: string | null;
  /** Cuándo terminó el alta en 3 preguntas. */
  quickStartAt?: string | null;
  /**
   * Aula que ya trabajaba antes de pasar al modo sencillo (cursos, alumnos o
   * ventas): se adoptó tal cual, sin alta en 3 preguntas.
   */
  adoptedAt?: string | null;
  /**
   * Idioma en el que la creadora montó el aula (el de la interfaz en el alta
   * en 3 preguntas). Es «el idioma del aula» para lo que el servidor escribe a
   * todos: ver `common/academy-defaults.ts`.
   */
  locale?: SimpleLocale;
  /**
   * Cuándo confirmó el creador el precio (lo guardó en «Empieza aquí», en
   * «Ventas» o en el editor del curso, o publicó viéndolo). El del alta en 3
   * preguntas es solo un precio de partida: hasta confirmarlo, el paso
   * «Precio» no cuenta como hecho (ensayo de venta real: se publicó a un
   * precio que nadie había vuelto a mirar). `null` tras repetir el alta.
   */
  priceConfirmedAt?: string | null;
}

/** Color por defecto del tema (el azul de Didacta): igual = el creador no lo tocó. */
const DEFAULT_BRAND_HUE = 213;

const STAFF_ROLES = ['super_admin', 'tenant_admin', 'formador'];

/**
 * Lógica del modo sencillo: el camino de 0 a vender del creador.
 *
 * Es infraestructura del host (como `/setup`): orquesta los servicios
 * PÚBLICOS de cada módulo (`mod.courses`, `mod.community`, `mod.billing`,
 * `mod.subscriptions`) para que el creador no tenga que conocerlos. Solo
 * ESCRIBE a través de esos servicios; las lecturas directas de sus tablas
 * filtran siempre por `tenant_id` (ADR-016, core first-party) y además corren
 * bajo RLS.
 */
@Injectable()
export class SimpleModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly stripeResolver: TenantStripeResolverService,
    // Solo existe con los cobros de plataforma encendidos (Didacta Cloud).
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  // ── Interruptor ──────────────────────────────────────────────────────────

  async isEnabled(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { simpleMode: true },
    });
    return tenant?.simpleMode === true;
  }

  async setEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { simpleMode: enabled },
      select: { simpleMode: true },
    });
    return tenant.simpleMode;
  }

  // ── Monedas ──────────────────────────────────────────────────────────────

  /**
   * Monedas en las que este aula puede poner precio. Con cobros de plataforma,
   * la lista de la plataforma (y la de liquidación del creador si ya conectó);
   * con claves propias, las de siempre.
   */
  async currencies(tenantId: string): Promise<{
    currencies: readonly string[];
    settlementCurrency: string | null;
    fees: PriceFeesView;
  }> {
    const [allowed, fees] = await Promise.all([
      this.priceCurrencies(tenantId),
      this.feesFor(tenantId),
    ]);
    return { ...allowed, fees };
  }

  private async priceCurrencies(
    tenantId: string,
  ): Promise<{ currencies: readonly string[]; settlementCurrency: string | null }> {
    const policy = this.payoutsGate ? await this.payoutsGate.pricePolicy(tenantId) : null;
    if (policy) {
      return { currencies: policy.currencies, settlementCurrency: policy.settlementCurrency };
    }
    return {
      currencies: this.payoutsGate ? PLATFORM_CURRENCIES : OWN_KEYS_CURRENCIES,
      settlementCurrency: null,
    };
  }

  /**
   * Comisiones para la estimación «con 49 € te llegan ~44 €»: la del operador
   * es la VIGENTE del aula (`mod_payouts_settings`, por defecto
   * `PAYMENTS_PLATFORM_DEFAULT_FEE_BPS`) y la de la tarjeta, la configurada
   * (`PAYMENTS_PLATFORM_CARD_FEE_ESTIMATE`). Con claves propias no hay
   * comisión del operador y la de la tarjeta es la tarifa estándar como
   * aproximación.
   */
  private async feesFor(tenantId: string): Promise<PriceFeesView> {
    const platform = this.payoutsGate ? await this.payoutsGate.feeEstimate(tenantId) : null;
    const card = platform?.cardFee ?? DEFAULT_CARD_FEE_ESTIMATE;
    return {
      platformFeeBps: platform?.platformFeeBps ?? null,
      operatorName: platform?.operatorName ?? null,
      cardFeeBps: card.bps,
      cardFeeFixed: card.fixedMinor,
    };
  }

  // ── Alta en 3 preguntas ──────────────────────────────────────────────────

  /**
   * Crea lo mínimo para empezar a vender, con filas REALES y borrables:
   * nombre del aula, el curso (con un apartado vacío) o el plan de membresía
   * en borrador, el precio pensado, los espacios básicos de la comunidad y un
   * post de bienvenida firmado por el creador.
   *
   * Idempotente: repetirla no duplica el curso ni el plan; actualiza el nombre
   * y el precio.
   */
  async quickStart(
    tenantId: string,
    creator: { id: string },
    input: QuickStartInput,
  ): Promise<{ offer: OfferIntent }> {
    const academyName = input.academyName.trim();
    const offerTitle = (input.title ?? '').trim() || academyName;
    await this.assertCurrency(tenantId, input.currency, input.amountCents);
    // El idioma de la academia: el elegido en el alta o, si no llega, el que ya
    // tenga el aula. Con él se crean el curso, los espacios y el post, y queda
    // como ajuste del aula (lo que ven los visitantes, los correos…).
    const locale: SimpleLocale =
      input.locale ??
      (await academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId));

    await this.prisma.tenant.update({ where: { id: tenantId }, data: { name: academyName } });

    // El creador necesita un nombre visible (firma su post y aparece en la
    // comunidad). Si Cloud no lo mandó, se usa el de la academia: lo cambia
    // cuando quiera en su perfil. La foto es opcional en modo sencillo.
    const creatorRow = await this.prisma.user.findUnique({
      where: { id: creator.id },
      select: { name: true, onboardingCompletedAt: true },
    });
    const displayName = creatorRow?.name?.trim() || academyName;
    await this.prisma.user.update({
      where: { id: creator.id },
      data: {
        ...(creatorRow?.name?.trim() ? {} : { name: academyName }),
        ...(creatorRow?.onboardingCompletedAt ? {} : { onboardingCompletedAt: new Date() }),
      },
    });

    const previous = await this.readOffer(tenantId);
    let offer: OfferIntent;
    if (input.offer === 'course') {
      const courseId =
        previous?.kind === 'course' &&
        previous.courseId &&
        (await this.courseExists(tenantId, previous.courseId))
          ? previous.courseId
          : await this.createDraftCourse(tenantId, creator.id, offerTitle, locale);
      if (previous?.courseId === courseId || input.coverUrl) {
        await this.registry.getCoursesService().updateCourse(tenantId, creator.id, courseId, {
          ...(previous?.courseId === courseId ? { title: offerTitle } : {}),
          ...(input.coverUrl ? { thumbnailUrl: input.coverUrl } : {}),
        });
      }
      offer = {
        kind: 'course',
        courseId,
        planId: null,
        amountCents: input.amountCents,
        currency: input.currency,
      };
    } else {
      const membership = this.registry.getMembershipService();
      const existingPlan =
        previous?.kind === 'membership' && previous.planId
          ? (await membership.listPlans(tenantId)).find((p) => p.id === previous.planId)
          : undefined;
      const plan = existingPlan
        ? await membership.updatePlan(tenantId, existingPlan.id, {
            name: offerTitle,
            amountCents: input.amountCents,
            currency: input.currency,
          })
        : await membership.createPlan(tenantId, {
            name: offerTitle,
            intervalMonths: 1,
            amountCents: input.amountCents,
            currency: input.currency,
            active: true,
          });
      offer = {
        kind: 'membership',
        courseId: null,
        planId: plan.id,
        amountCents: input.amountCents,
        currency: input.currency,
      };
    }
    await this.writeSetting(tenantId, creator.id, OFFER_KEY, offer);

    await this.ensureCommunity(tenantId, { id: creator.id, displayName }, academyName, locale);

    await this.writeState(tenantId, creator.id, {
      quickStartAt: new Date().toISOString(),
      locale,
      // El precio del alta es de partida: se confirma en «Empieza aquí».
      priceConfirmedAt: null,
    });
    await writeAcademyLocale(
      this.prisma as unknown as AcademyLocaleWriter,
      tenantId,
      locale,
      creator.id,
    );
    await this.completeLegacyWizard(tenantId, creator.id);
    return { offer };
  }

  // ── Precio ───────────────────────────────────────────────────────────────

  /**
   * Cambia el precio. Si ya está a la venta, cambia también la opción de compra
   * (curso) o el plan (membresía), que es lo que ve el alumno.
   */
  async updatePrice(
    tenantId: string,
    actorId: string,
    price: { amountCents: number; currency: string },
  ): Promise<OfferIntent> {
    await this.assertCurrency(tenantId, price.currency, price.amountCents);
    const offer = (await this.currentOffer(tenantId)) ?? emptyOfferIntent();
    const next: OfferIntent = { ...offer, ...price };
    if (next.kind === 'membership' && next.planId) {
      await this.registry.getMembershipService().updatePlan(tenantId, next.planId, price);
    }
    if (next.kind === 'course' && next.courseId) {
      // Solo si ya está a la venta: antes de publicar, el precio vive en la
      // intención y la opción de compra se crea al publicar.
      const product = await this.activeProductFor(tenantId, next.courseId);
      if (product) await this.upsertSinglePrice(tenantId, next.courseId, price);
    }
    await this.writeSetting(tenantId, actorId, OFFER_KEY, next);
    await this.writeState(tenantId, actorId, { priceConfirmedAt: new Date().toISOString() });
    return next;
  }

  // ── Precio y venta de un curso (editor del curso) ────────────────────────

  /**
   * El bloque «Precio y venta» del editor de un curso: el precio y el estado
   * de venta tal como los ve «Empieza aquí» (curso de la oferta o membresía) o
   * los de su propia opción de compra (curso vendido aparte).
   */
  async courseSale(tenantId: string, courseId: string): Promise<CourseSaleView> {
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (!course) {
      throw new SimpleModeError('SIMPLE_MODE_COURSE_NOT_FOUND', 'El curso no existe.');
    }
    const [offer, canSell] = await Promise.all([
      this.currentOffer(tenantId),
      this.paymentsReady(tenantId),
    ]);
    const stateOf = (published: boolean): CourseSaleView['state'] =>
      published ? (canSell ? 'on-sale' : 'not-purchasable') : 'unpublished';

    if (offer?.kind === 'course' && offer.courseId === course.id) {
      const published = await this.isPublished(tenantId, offer, course);
      return {
        courseId: course.id,
        role: 'offer',
        price:
          offer.amountCents > 0
            ? { amountCents: offer.amountCents, currency: offer.currency, intervalMonths: null }
            : null,
        state: stateOf(published),
        salePath: published ? `/catalog/${course.slug}` : null,
        editable: true,
        offerTitle: null,
      };
    }
    if (offer?.kind === 'membership') {
      const plan = offer.planId
        ? await this.prisma.modSubscriptionsPlan.findFirst({
            where: { id: offer.planId, tenantId },
            select: { name: true, intervalMonths: true },
          })
        : null;
      const published = await this.isPublished(tenantId, offer, null);
      return {
        courseId: course.id,
        role: 'membership',
        price:
          offer.amountCents > 0
            ? {
                amountCents: offer.amountCents,
                currency: offer.currency,
                intervalMonths: plan?.intervalMonths ?? 1,
              }
            : null,
        state: stateOf(published),
        salePath: published ? '/join' : null,
        editable: plan !== null,
        offerTitle: plan?.name ?? null,
      };
    }
    // Se vende aparte (o no se vende): su propia opción de compra.
    const product = await this.activeProductFor(tenantId, course.id);
    const published = course.status === 'PUBLISHED' && product !== null;
    const offerCourse =
      offer?.kind === 'course' && offer.courseId
        ? await this.prisma.modCoursesCourse.findFirst({
            where: { id: offer.courseId, tenantId, deletedAt: null },
            select: { title: true },
          })
        : null;
    return {
      courseId: course.id,
      role: 'separate',
      price: product
        ? { amountCents: product.unitAmount, currency: product.currency, intervalMonths: null }
        : null,
      state: stateOf(published),
      salePath: published ? `/catalog/${course.slug}` : null,
      editable: product !== null,
      offerTitle: offerCourse?.title ?? null,
    };
  }

  /**
   * Cambia el precio desde el editor del curso. Si el curso es la oferta (o va
   * dentro de la membresía) es EXACTAMENTE el paso «Precio» de «Empieza aquí»
   * (`updatePrice`); si se vende aparte, cambia su opción de compra con el
   * mismo camino que el panel de precios del curso.
   */
  async updateCoursePrice(
    tenantId: string,
    actorId: string,
    courseId: string,
    price: { amountCents: number; currency: string },
  ): Promise<CourseSaleView> {
    const view = await this.courseSale(tenantId, courseId);
    if (!view.editable) {
      throw new SimpleModeError(
        'SIMPLE_MODE_COURSE_NOT_FOR_SALE',
        'Este curso no se vende por separado.',
      );
    }
    if (view.role === 'separate') {
      await this.assertCurrency(tenantId, price.currency, price.amountCents);
      await this.upsertSinglePrice(tenantId, courseId, price);
    } else {
      await this.updatePrice(tenantId, actorId, price);
    }
    return this.courseSale(tenantId, courseId);
  }

  /** «Tu academia» guardada (aunque el creador se quede con el logo y color de serie). */
  async confirmAcademy(tenantId: string, actorId: string): Promise<void> {
    await this.writeState(tenantId, actorId, { academyConfirmedAt: new Date().toISOString() });
  }

  // ── Aulas que ya trabajaban ──────────────────────────────────────────────

  /**
   * Un aula que pasa al modo sencillo con trabajo hecho (cursos, alumnos o
   * ventas) NO puede encontrarse el alta «de cero»: crearía un segundo curso
   * y pisaría el nombre. Se adopta tal cual: se da por hecho el asistente de
   * academia (el gate del aula deja de mandarla a `/welcome`) y se anota.
   * Un aula vacía no se adopta: para ella el alta en 3 preguntas es el camino.
   *
   * Idempotente. La comprobación es del servidor: el cliente solo pregunta.
   */
  async adoptExisting(tenantId: string, actorId: string): Promise<{ adopted: boolean }> {
    const state = await this.readState(tenantId);
    if (state.quickStartAt || state.adoptedAt) return { adopted: Boolean(state.adoptedAt) };
    if (!(await this.hasExistingWork(tenantId))) return { adopted: false };
    await this.writeState(tenantId, actorId, { adoptedAt: new Date().toISOString() });
    await this.completeLegacyWizard(tenantId, actorId);
    await this.prisma.user.updateMany({
      where: { id: actorId, tenantId, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: new Date() },
    });
    return { adopted: true };
  }

  private async hasExistingWork(tenantId: string): Promise<boolean> {
    const [courses, students, sales] = await Promise.all([
      this.prisma.modCoursesCourse.count({ where: { tenantId, deletedAt: null } }),
      this.invitedCount(tenantId),
      this.salesSummary(tenantId),
    ]);
    return courses > 0 || students > 0 || sales.count > 0;
  }

  // ── Publicar ─────────────────────────────────────────────────────────────

  /**
   * Publica la oferta y la pone a la venta. Curso: lo publica y crea su opción
   * de compra con el precio guardado. Membresía: enciende la página `/join`.
   * Devuelve la RUTA del enlace de venta (el host lo pone el navegador, que ya
   * está en el dominio del aula).
   */
  async publish(tenantId: string, actorId: string): Promise<{ salePath: string }> {
    const offer = await this.currentOffer(tenantId);
    if (!offer || offer.amountCents <= 0) {
      throw new SimpleModeError('SIMPLE_MODE_NO_PRICE', 'Pon un precio antes de publicar.');
    }
    if (!(await this.paymentsReady(tenantId))) {
      throw new SimpleModeError(
        'SIMPLE_MODE_PAYMENTS_NOT_READY',
        'Conecta tus cobros antes de publicar: sin ellos nadie podría pagarte.',
      );
    }
    // Sin datos fiscales SÍ se publica (decisión de producto, web #39: se
    // cobra igual y se retienen las transferencias; que venda cuanto antes).
    // Lo avisan el paso «Conecta tus cobros» y «Ventas», no un bloqueo.

    // Publicar es confirmar el precio: el botón lo enseña («Publicar a 49 €»)
    // junto a lo que le llega y la opción de cambiarlo.
    await this.writeState(tenantId, actorId, { priceConfirmedAt: new Date().toISOString() });

    if (offer.kind === 'membership') {
      if (!offer.planId) {
        throw new SimpleModeError('SIMPLE_MODE_NO_OFFER', 'No hay ninguna membresía que publicar.');
      }
      const membership = this.registry.getMembershipService();
      await membership.updatePlan(tenantId, offer.planId, { active: true });
      await membership.updateConfig(tenantId, { active: true });
      return { salePath: '/join' };
    }

    if (!offer.courseId) {
      throw new SimpleModeError('SIMPLE_MODE_NO_OFFER', 'No hay ningún curso que publicar.');
    }
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { id: offer.courseId, tenantId, deletedAt: null },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (!course) {
      throw new SimpleModeError('SIMPLE_MODE_NO_OFFER', 'El curso ya no existe.');
    }
    if (course.status !== 'PUBLISHED') {
      try {
        await this.registry.getCoursesService().publishCourse(tenantId, actorId, course.id);
      } catch (err) {
        if (err instanceof CourseHasNoLessonsError) {
          throw new SimpleModeError(
            'SIMPLE_MODE_NO_LESSONS',
            'Añade al menos una lección antes de publicar.',
          );
        }
        if (!(err instanceof CourseAlreadyPublishedError)) throw err;
      }
    }

    await this.upsertSinglePrice(tenantId, course.id, offer, course.title);
    return { salePath: `/catalog/${course.slug}` };
  }

  // ── Empieza aquí ─────────────────────────────────────────────────────────

  async startHere(tenantId: string): Promise<StartHereView> {
    const [tenant, offer, state] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.currentOffer(tenantId),
      this.readState(tenantId),
    ]);

    const course = offer?.courseId
      ? await this.prisma.modCoursesCourse.findFirst({
          where: { id: offer.courseId, tenantId, deletedAt: null },
          select: { id: true, slug: true, title: true, status: true, thumbnailUrl: true },
        })
      : null;

    const [
      academyDone,
      courseDone,
      paymentsReady,
      invited,
      sales,
      nextLive,
      published,
      taxPending,
    ] = await Promise.all([
      this.academyDone(tenantId, state),
      this.courseWithContent(tenantId, offer),
      this.paymentsReady(tenantId),
      this.invitedCount(tenantId),
      this.salesSummary(tenantId),
      this.nextLive(tenantId),
      this.isPublished(tenantId, offer, course),
      this.taxProfilePending(tenantId),
    ]);
    // La cuenta puede vender pero, sin datos fiscales, el dinero no llegaría.
    const taxProfilePending = paymentsReady && taxPending;
    // El precio del alta es de partida hasta que el creador lo confirma. Las
    // aulas sin alta (adoptadas o de antes) y lo ya publicado o vendido lo
    // tienen confirmado: es el precio que eligieron y el que se cobra.
    const priceConfirmed =
      !state.quickStartAt || Boolean(state.priceConfirmedAt) || published || sales.count > 0;

    const done: Record<StepId, boolean> = {
      // Quien ya vende o tiene algo publicado tiene academia, aunque nunca
      // tocara el logo ni el color.
      academy: academyDone || published || sales.count > 0,
      course: courseDone.done,
      price: (offer?.amountCents ?? 0) > 0 && priceConfirmed,
      // «Listo para cobrar» es que el dinero LLEGA: con la cuenta conectada y
      // los datos fiscales completos (si la plataforma los exige).
      payments: paymentsReady && !taxProfilePending,
      // Publicado no basta: sin cobros nadie puede comprar todavía. (Con los
      // datos fiscales pendientes sí se puede comprar: el paso de cobros lo
      // marca aparte.)
      publish: published && paymentsReady,
      invite: invited > 0 || sales.count > 0,
    };

    const salePath = published
      ? offer?.kind === 'membership'
        ? '/join'
        : course
          ? `/catalog/${course.slug}`
          : null
      : null;

    return {
      academyName: tenant?.name ?? '',
      quickStartDone: Boolean(state.quickStartAt),
      offer: offer
        ? {
            ...offer,
            courseTitle: course?.title ?? null,
            courseSlug: course?.slug ?? null,
            courseCoverUrl: course?.thumbnailUrl ?? null,
          }
        : null,
      firstCourseId: courseDone.courseId,
      steps: STEP_IDS.map((id) => ({ id, done: done[id] })),
      salePath,
      sales,
      students: invited,
      nextLive,
      paymentsSetupPath: this.payoutsGate ? '/admin/payments' : '/admin/settings?tab=payments',
      taxProfilePending,
      taxProfilePath: '/admin/payments#tax-profile',
      priceConfirmed,
    };
  }

  // ── Lecturas auxiliares ──────────────────────────────────────────────────

  async readOffer(tenantId: string): Promise<OfferIntent | null> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: {
        tenantId_moduleName_key: {
          tenantId,
          moduleName: SIMPLE_MODE_SETTINGS_SCOPE,
          key: OFFER_KEY,
        },
      },
      select: { valueJson: true },
    });
    const v = row?.valueJson as Partial<OfferIntent> | null | undefined;
    if (!v || (v.kind !== 'course' && v.kind !== 'membership')) return null;
    return {
      kind: v.kind,
      courseId: typeof v.courseId === 'string' ? v.courseId : null,
      planId: typeof v.planId === 'string' ? v.planId : null,
      amountCents: typeof v.amountCents === 'number' ? v.amountCents : 0,
      currency: typeof v.currency === 'string' ? v.currency : 'eur',
    };
  }

  /**
   * La oferta con la que trabaja «Empieza aquí»: la guardada por el modo
   * sencillo o, en un aula que ya vendía antes de pasar a él, la que se deduce
   * de lo que ya tiene a la venta. Así no le pide de nuevo precio ni publicar.
   */
  async currentOffer(tenantId: string): Promise<OfferIntent | null> {
    const stored = await this.readOffer(tenantId);
    if (!stored) return this.inferOffer(tenantId);
    return this.withLivePrice(tenantId, stored);
  }

  /**
   * Ya a la venta, el precio que manda es el que paga el alumno: el de la
   * opción de compra del curso o el del plan de la membresía. La intención
   * guardada solo lleva el precio ANTES de publicar. Así «Empieza aquí»,
   * «Ventas» y el editor del curso enseñan el mismo precio aunque se cambiara
   * desde el modo completo (que escribe en la opción de compra o en el plan).
   */
  private async withLivePrice(tenantId: string, offer: OfferIntent): Promise<OfferIntent> {
    if (offer.kind === 'membership' && offer.planId) {
      const plan = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { id: offer.planId, tenantId },
        select: { amountCents: true, currency: true },
      });
      return plan ? { ...offer, amountCents: plan.amountCents, currency: plan.currency } : offer;
    }
    if (offer.kind === 'course' && offer.courseId) {
      const product = await this.activeProductFor(tenantId, offer.courseId);
      return product
        ? { ...offer, amountCents: product.unitAmount, currency: product.currency }
        : offer;
    }
    return offer;
  }

  /**
   * Deduce la oferta de un aula sin estado del modo sencillo. Por orden:
   * 1. la membresía si está encendida (su plan activo más barato, el de entrada);
   * 2. el curso PUBLICADO con opción de compra activa (si hay varios, el de la
   *    opción más antigua);
   * 3. el primer curso del aula, aún sin precio.
   * Solo lee; nada se guarda hasta que el creador toca algo.
   */
  async inferOffer(tenantId: string): Promise<OfferIntent | null> {
    const config = await this.prisma.modSubscriptionsMembershipConfig.findUnique({
      where: { tenantId },
      select: { active: true },
    });
    if (config?.active) {
      const plan = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { tenantId, active: true },
        orderBy: [{ amountCents: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, amountCents: true, currency: true },
      });
      if (plan) {
        return {
          kind: 'membership',
          courseId: null,
          planId: plan.id,
          amountCents: plan.amountCents,
          currency: plan.currency,
        };
      }
    }
    // Sin FK entre módulos (billing ↔ courses): dos lecturas, ambas por tenant.
    const products = await this.prisma.modBillingProduct.findMany({
      where: { tenantId, active: true },
      orderBy: [{ createdAt: 'asc' }],
      select: { courseId: true, unitAmount: true, currency: true },
      take: 200,
    });
    const published = products.length
      ? new Set(
          (
            await this.prisma.modCoursesCourse.findMany({
              where: {
                tenantId,
                deletedAt: null,
                status: 'PUBLISHED',
                id: { in: [...new Set(products.map((p) => p.courseId))] },
              },
              select: { id: true },
            })
          ).map((c) => c.id),
        )
      : new Set<string>();
    const product = products.find((p) => published.has(p.courseId));
    if (product) {
      return {
        kind: 'course',
        courseId: product.courseId,
        planId: null,
        amountCents: product.unitAmount,
        currency: product.currency,
      };
    }
    const course = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return course
      ? { kind: 'course', courseId: course.id, planId: null, amountCents: 0, currency: 'eur' }
      : null;
  }

  private async readState(tenantId: string): Promise<SimpleModeState> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: {
        tenantId_moduleName_key: {
          tenantId,
          moduleName: SIMPLE_MODE_SETTINGS_SCOPE,
          key: STATE_KEY,
        },
      },
      select: { valueJson: true },
    });
    const v = row?.valueJson;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SimpleModeState) : {};
  }

  private async writeState(tenantId: string, actorId: string, patch: SimpleModeState) {
    const current = await this.readState(tenantId);
    await this.writeSetting(tenantId, actorId, STATE_KEY, { ...current, ...patch });
  }

  /**
   * El alta en 3 preguntas SUSTITUYE al asistente de academia de 12 pantallas:
   * se marca como terminado (`onboarding/academy`, el mismo ajuste que lee el
   * shell) para que el aula no vuelva a mandar al creador a él.
   */
  private async completeLegacyWizard(tenantId: string, actorId: string) {
    const where = {
      tenantId_moduleName_key: { tenantId, moduleName: 'onboarding', key: 'academy' },
    };
    const value = { step: 'resumen', done: [], skipped: [], completedAt: new Date().toISOString() };
    await this.prisma.tenantSetting.upsert({
      where,
      create: {
        tenantId,
        moduleName: 'onboarding',
        key: 'academy',
        isSecret: false,
        valueJson: value,
        updatedById: actorId,
      },
      update: { valueJson: value, updatedById: actorId },
    });
  }

  private async writeSetting(tenantId: string, actorId: string, key: string, value: object) {
    await this.prisma.tenantSetting.upsert({
      where: {
        tenantId_moduleName_key: { tenantId, moduleName: SIMPLE_MODE_SETTINGS_SCOPE, key },
      },
      create: {
        tenantId,
        moduleName: SIMPLE_MODE_SETTINGS_SCOPE,
        key,
        isSecret: false,
        valueJson: value,
        updatedById: actorId,
      },
      update: { valueJson: value, updatedById: actorId },
    });
  }

  /** ¿Cobra por la plataforma y le faltan los datos fiscales (que se exigen)? */
  async taxProfilePending(tenantId: string): Promise<boolean> {
    if (!this.payoutsGate) return false;
    try {
      return await this.payoutsGate.taxProfilePending(tenantId);
    } catch {
      // Sin poder leerlo, no se bloquea nada: el aviso de «Ventas» sigue ahí.
      return false;
    }
  }

  /** ¿Puede cobrar ya este aula? Plataforma lista, o claves propias puestas. */
  async paymentsReady(tenantId: string): Promise<boolean> {
    if (this.payoutsGate) {
      const policy = await this.payoutsGate.pricePolicy(tenantId);
      // Con la plataforma encendida y claves propias del aula (`own`), cobra
      // con ellas: lista. Si cobra por la plataforma, lista solo si su cuenta
      // conectada ya puede vender.
      if (policy === null) return true;
      return (await this.payoutsGate.saleBlockedReason(tenantId)) === null;
    }
    return (await this.stripeResolver.resolve(tenantId)) !== null;
  }

  private async assertCurrency(tenantId: string, currency: string, amountCents: number) {
    const { currencies } = await this.priceCurrencies(tenantId);
    if (!currencies.includes(currency)) {
      throw new SimpleModeError(
        'SIMPLE_MODE_CURRENCY_NOT_SUPPORTED',
        `No se puede cobrar en ${currency.toUpperCase()} en esta academia.`,
      );
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new SimpleModeError('SIMPLE_MODE_NO_PRICE', 'El precio tiene que ser mayor que cero.');
    }
    if (this.payoutsGate) {
      await this.payoutsGate.assertPrice(tenantId, { currency, amounts: [amountCents] });
    }
  }

  private async courseExists(tenantId: string, courseId: string): Promise<boolean> {
    const c = await this.prisma.modCoursesCourse.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { id: true },
    });
    return c !== null;
  }

  private async createDraftCourse(
    tenantId: string,
    actorId: string,
    title: string,
    locale: SimpleLocale,
  ): Promise<string> {
    const courses = this.registry.getCoursesService();
    const { firstModule, courseLanguage } = textsFor(locale);
    const base = toCourseSlug(title);
    for (let attempt = 1; attempt <= 20; attempt++) {
      const slug = attempt === 1 ? base : `${base.slice(0, 90)}-${attempt}`;
      try {
        const course = await courses.createCourse(tenantId, actorId, {
          slug,
          title,
          language: courseLanguage,
        });
        await courses.createModule(tenantId, actorId, course.id, { title: firstModule });
        return course.id;
      } catch (err) {
        if (err instanceof CourseSlugAlreadyExistsError) continue;
        throw err;
      }
    }
    throw new SimpleModeError('SIMPLE_MODE_SLUG_EXHAUSTED', 'No se pudo crear el curso.');
  }

  /**
   * Espacios básicos (los mismos cuatro que siembra el arranque, en el idioma
   * del creador) y un post de bienvenida firmado por él. Un aula creada en
   * caliente no los tenía hasta el siguiente arranque del contenedor.
   */
  private async ensureCommunity(
    tenantId: string,
    author: { id: string; displayName: string },
    academyName: string,
    locale: SimpleLocale,
  ) {
    const community = this.registry.getCommunityService();
    const texts = textsFor(locale);
    for (const space of texts.spaces) {
      try {
        await community.createSpace(tenantId, author.id, space);
      } catch (err) {
        if (!(err instanceof SpaceAlreadyExistsError)) throw err;
      }
    }
    const already = await this.prisma.modCommunityPost.findFirst({
      where: { tenantId, authorId: author.id, deletedAt: null },
      select: { id: true },
    });
    if (already) return;
    await community.createPost(tenantId, author, {
      title: texts.welcomeTitle(academyName),
      body: texts.welcomeBody(academyName),
      tags: ['general'],
      // Sin avisar a nadie: aún no hay alumnos y es el saludo que encontrarán.
      notifyAll: false,
      important: false,
    });
  }

  /**
   * «Tu academia» queda hecha con el alta (ya tiene nombre y, mientras no suba
   * los suyos, el logo y el color de Didacta): vender no necesita más, y
   * dejarla como paso abierto frenaba al creador antes de su curso. El logo y
   * el color se cambian desde «Cambiar».
   */
  private async academyDone(tenantId: string, state: SimpleModeState): Promise<boolean> {
    if (state.academyConfirmedAt || state.quickStartAt || state.adoptedAt) return true;
    // El asistente de academia del modo completo, ya terminado.
    const legacy = await this.prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName: 'onboarding', key: 'academy' } },
      select: { valueJson: true },
    });
    const legacyValue = legacy?.valueJson as { completedAt?: unknown } | null | undefined;
    if (legacyValue && typeof legacyValue.completedAt === 'string') return true;
    const theme = await this.prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
      select: { logoUrl: true, brandHue: true },
    });
    return Boolean(theme && (theme.logoUrl || theme.brandHue !== DEFAULT_BRAND_HUE));
  }

  /**
   * Hecho cuando hay un curso con al menos una lección CON contenido (una
   * lección vacía todavía no se puede vender). Primero el de la oferta; si no,
   * cualquiera del aula (en membresía, el primero que tenga).
   */
  private async courseWithContent(
    tenantId: string,
    offer: OfferIntent | null,
  ): Promise<{ done: boolean; courseId: string | null }> {
    const lessons = await this.prisma.modCoursesLesson.findMany({
      where: {
        tenantId,
        deletedAt: null,
        module: {
          deletedAt: null,
          course: {
            deletedAt: null,
            ...(offer?.kind === 'course' && offer.courseId ? { id: offer.courseId } : {}),
          },
        },
      },
      select: { type: true, content: true, module: { select: { courseId: true } } },
      take: 200,
    });
    const withContent = lessons.find((l) => lessonHasContent(l.type, l.content));
    if (withContent) return { done: true, courseId: withContent.module.courseId };
    if (offer?.kind === 'course' && offer.courseId)
      return { done: false, courseId: offer.courseId };
    const first = await this.prisma.modCoursesCourse.findFirst({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return { done: false, courseId: first?.id ?? null };
  }

  /**
   * Precio único del curso (opción sin nombre): lo crea, lo cambia o lo
   * reactiva con el mismo camino que usa el panel de precios del curso.
   */
  private async upsertSinglePrice(
    tenantId: string,
    courseId: string,
    price: { amountCents: number; currency: string },
    courseTitle?: string,
  ) {
    const title =
      courseTitle ??
      (
        await this.prisma.modCoursesCourse.findFirst({
          where: { id: courseId, tenantId },
          select: { title: true },
        })
      )?.title;
    await this.registry.getBillingService().upsertCoursePrice({
      tenantId,
      courseId,
      unitAmount: price.amountCents,
      currency: price.currency,
      name: title,
      optionName: '',
    });
  }

  /** La opción de compra activa del curso: la de precio único si la hay. */
  private async activeProductFor(tenantId: string, courseId: string) {
    const products = await this.registry.getBillingService().listProducts(tenantId);
    const active = products.filter((p) => p.courseId === courseId && p.active);
    return active.find((p) => !p.name) ?? active[0] ?? null;
  }

  private async isPublished(
    tenantId: string,
    offer: OfferIntent | null,
    course: { status: string; id: string } | null,
  ): Promise<boolean> {
    if (!offer) return false;
    if (offer.kind === 'membership') {
      if (!offer.planId) return false;
      const config = await this.prisma.modSubscriptionsMembershipConfig.findUnique({
        where: { tenantId },
        select: { active: true },
      });
      const plan = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { id: offer.planId, tenantId },
        select: { active: true },
      });
      return Boolean(config?.active && plan?.active);
    }
    if (!course || course.status !== 'PUBLISHED') return false;
    return (await this.activeProductFor(tenantId, course.id)) !== null;
  }

  /** Personas del aula que no son del equipo: invitadas o ya dentro. */
  private async invitedCount(tenantId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        tenantId,
        deletedAt: null,
        roles: { none: { role: { name: { in: STAFF_ROLES } } } },
      },
    });
  }

  private async salesSummary(tenantId: string): Promise<StartHereView['sales']> {
    const [orders, subscriptions, firstOrder] = await Promise.all([
      this.prisma.modBillingOrder.count({ where: { tenantId, status: 'COMPLETED' } }),
      this.prisma.modSubscriptionsSubscription.count({
        where: {
          tenantId,
          // PAUSED: vendida y en pausa a petición del alumno (sigue siendo una venta).
          status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'PAUSED'] },
        },
      }),
      this.prisma.modBillingOrder.findFirst({
        where: { tenantId, status: 'COMPLETED' },
        orderBy: { completedAt: 'asc' },
        select: { completedAt: true },
      }),
    ]);
    return {
      count: orders + subscriptions,
      firstSaleAt: firstOrder?.completedAt?.toISOString() ?? null,
    };
  }

  private async nextLive(tenantId: string): Promise<StartHereView['nextLive']> {
    const s = await this.prisma.modZoomSession.findFirst({
      where: { tenantId, startTime: { gte: new Date() } },
      orderBy: { startTime: 'asc' },
      select: { id: true, topic: true, startTime: true },
    });
    return s ? { id: s.id, topic: s.topic, startTime: s.startTime.toISOString() } : null;
  }
}
