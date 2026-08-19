/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '@didacta/core-registry';
import { Prisma } from '@didacta/database';
import {
  AiContentService,
  buildAiContentModule,
  type LessonTextResolver as AiContentLessonResolver,
} from '@didacta/mod-ai-content';
import { extractLessonText, type LessonType } from '@didacta/mod-ai-tutor';
import { assessmentsModule, AssessmentsService } from '@didacta/mod-assessments';
import {
  BillingService,
  buildBillingModule,
  StripeConfigMissingError as BillingStripeConfigMissingError,
  StripeSdkAdapter,
  type BillingEventPublisher,
  type CheckoutUrlBuilder,
  type StripeAdapter,
  type StripeAdapterResolver,
} from '@didacta/mod-billing';
import {
  MembershipService,
  StripeConfigMissingError as SubscriptionsStripeConfigMissingError,
  SubscriptionsService,
  SubscriptionsStripeSdkAdapter,
  buildSubscriptionsModule,
  DEFAULT_GRACE_PERIOD_DAYS,
  type CheckoutUrlBuilder as SubsCheckoutUrlBuilder,
  type CoursePriceCatalog as SubsCoursePriceCatalog,
  type SubscriptionsEventPublisher,
  type SubscriptionsStripeAdapter,
  type SubscriptionsStripeAdapterResolver,
} from '@didacta/mod-subscriptions';
import {
  buildReferralsModule,
  ReferralsService,
  type ReferralsEventPublisher,
} from '@didacta/mod-referrals';
import {
  buildMessagingModule,
  MessagingService,
  MESSAGING_STAFF_ROLES,
  type MessagingEventPublisher,
} from '@didacta/mod-messaging';
import {
  PaymentConnectionsService,
  PaymentTiersService,
  OrderMirrorService,
  StripeReadSdkAdapter,
  PayPalReadSdkAdapter,
  WooCommerceReadSdkAdapter,
  buildPaymentConnectionsModule,
  type ConfigPort as PaymentConnectionsConfigPort,
  type PaymentReadAdapterFactory,
  type StripeCredentials,
  type PayPalCredentials,
  type WooCommerceCredentials,
  type UserDirectoryPort as PaymentConnectionsUserDirectoryPort,
} from '@didacta/mod-payment-connections';
import { buildCertificatesModule, CertificatesService } from '@didacta/mod-certificates';
import { buildAccessGroupsModule } from '@didacta/mod-access-groups';
import { buildMemberRegistrationModule } from '@didacta/mod-member-registration';
import {
  buildSurveysModule,
  SurveysService,
  type SurveysEventPublisher,
} from '@didacta/mod-surveys';
import {
  buildResourcesModule,
  ResourcesService,
  type ResourcesEventPublisher,
} from '@didacta/mod-resources';
import {
  buildGamificationModule,
  GamificationService,
  type GamificationEventPublisher,
} from '@didacta/mod-gamification';
import { communityModule, CommunityService } from '@didacta/mod-community';
import { coursesModule, CoursesService } from '@didacta/mod-courses';
import { helloWorldModule } from '@didacta/mod-hello-world';
import { wpSsoModule } from '@didacta/mod-wp-sso';
import {
  fundaeModule,
  FundaeCompanyService,
  FundaeGroupParticipantService,
  FundaeGroupService,
  FundaeRlptService,
  FundaeService,
} from '@didacta/mod-fundae';
import {
  learningModule,
  LearningService,
  LearningPathsService,
  ScormService,
  type CourseSaleChecker as LearningCourseSaleChecker,
} from '@didacta/mod-learning';
import { themingModule, ThemingService } from '@didacta/mod-theming';
import { zoomLiveModule, ZoomLiveService } from '@didacta/mod-zoom-live';
import {
  aiTutorModule,
  AiTutorChatService,
  AiTutorIndexerService,
  AiTutorReviewService,
} from '@didacta/mod-ai-tutor';
import {
  aiGraderModule,
  AiGraderRubricService,
  AiGraderSuggestionService,
} from '@didacta/mod-ai-grader';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { runSanctionedGlobalAccess } from '../tenancy/tenant-context.storage';
import { ModuleContextFactory } from './module-context.factory';
import {
  TenantStripeResolverService,
  type StripeCredentials as BillingStripeCredentials,
} from './tenant-stripe-resolver.service';

/**
 * Versión de contrato del core contra la que se valida el `coreVersionRequired`
 * (`^0.0.1`) de los módulos first-party. El producto versiona 0.0.1-alpha.N;
 * se usa la base estable porque semver excluye prereleases de los rangos caret.
 */
const CORE_VERSION = '0.0.1';
/** Mismo TTL que el cache del ModuleAccessInterceptor, por coherencia. */
const MODULE_ENABLED_CACHE_TTL_MS = 30_000;

@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private registry?: ModuleRegistry;
  private courses?: CoursesService;
  private learning?: LearningService;
  private learningPaths?: LearningPathsService;
  private certificates?: CertificatesService;
  private assessments?: AssessmentsService;
  private community?: CommunityService;
  private theming?: ThemingService;
  private zoomLive?: ZoomLiveService;
  private fundae?: FundaeService;
  private fundaeCompanies?: FundaeCompanyService;
  private fundaeRlpt?: FundaeRlptService;
  private fundaeGroups?: FundaeGroupService;
  private fundaeGroupParticipants?: FundaeGroupParticipantService;
  private scorm?: ScormService;
  private aiTutorIndexer?: AiTutorIndexerService;
  private aiTutorChat?: AiTutorChatService;
  private aiTutorReview?: AiTutorReviewService;
  private aiGraderRubric?: AiGraderRubricService;
  private aiGraderSuggestion?: AiGraderSuggestionService;
  private aiContent?: AiContentService;
  private billing?: BillingService;
  private subscriptions?: SubscriptionsService;
  private membership?: MembershipService;
  private stripeResolver?: TenantStripeResolverService;
  /**
   * Adapters de instancia (env globales), memoizados al boot — evitan
   * reconstruir el cliente Stripe SDK en el caso común sin override de
   * tenant. Un tenant con credenciales propias en Administración → Pagos
   * siempre construye su propio adapter fresco (ver resolveStripeAdapter).
   */
  private globalStripeAdapter?: StripeAdapter;
  private globalSubscriptionsStripeAdapter?: SubscriptionsStripeAdapter;
  private paymentConnections?: PaymentConnectionsService;
  private paymentTiers?: PaymentTiersService;
  private orderMirror?: OrderMirrorService;
  private referrals?: ReferralsService;
  private messaging?: MessagingService;
  private surveys?: SurveysService;
  private resources?: ResourcesService;
  private gamification?: GamificationService;
  /** Cache de activación por (tenant, módulo) para consultas fuera del path HTTP. */
  private readonly moduleEnabledCache = new Map<string, { enabled: boolean; expiresAt: number }>();

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly pino: PinoLogger,
    private readonly aiGateway: AiGatewayService,
  ) {}

  async onModuleInit() {
    const context = this.factory.build();
    this.registry = new ModuleRegistry({ coreVersion: CORE_VERSION, context });

    const prisma = this.factory.getPrisma() as never;
    this.courses = new CoursesService(prisma, context);
    // ¿El tenant vende este curso? Un curso a la venta no admite
    // automatrícula: sin esto, el CTA de compra se saltaba con una llamada a
    // `POST /modules/learning/enroll`. Solo esta capa puede mirar los
    // catálogos de mod.billing y mod.subscriptions a la vez.
    const cursoALaVenta: LearningCourseSaleChecker = async (tenantId, courseId) => {
      const db = this.factory.getPrisma();
      const [producto, suscripcion] = await Promise.all([
        db.modBillingProduct.findFirst({
          where: { tenantId, courseId, active: true },
          select: { id: true },
        }),
        db.modSubscriptionsSubscription.findFirst({
          where: { tenantId, courseId },
          select: { id: true },
        }),
      ]);
      return producto !== null || suscripcion !== null;
    };
    this.learning = new LearningService(prisma, context, cursoALaVenta);
    this.learningPaths = new LearningPathsService(prisma, context);
    this.certificates = new CertificatesService(prisma, context);
    this.assessments = new AssessmentsService(prisma, context);
    this.community = new CommunityService(prisma, context);
    this.theming = new ThemingService(prisma, context);
    this.zoomLive = new ZoomLiveService(prisma, context);
    this.fundae = new FundaeService(prisma, context);
    this.fundaeCompanies = new FundaeCompanyService(prisma, context);
    this.fundaeRlpt = new FundaeRlptService(prisma, context);
    this.fundaeGroups = new FundaeGroupService(prisma, context, this.fundaeRlpt);
    this.fundaeGroupParticipants = new FundaeGroupParticipantService(prisma, context);
    this.scorm = new ScormService(prisma, context);

    // mod.ai-tutor: indexer + chat reciben embedFn/chatFn que delegan al
    // AI Gateway, resolviendo provider per-tenant.
    const embedFn = async (args: { tenantId: string; texts: string[] }) => {
      const result = await this.aiGateway.embed({
        tenantId: args.tenantId,
        input: { texts: args.texts },
      });
      return {
        embeddings: result.embeddings,
        totalTokens: result.usage.totalTokens,
        dimension: result.dimension,
      };
    };
    this.aiTutorIndexer = new AiTutorIndexerService(prisma, context, embedFn);
    this.aiTutorChat = new AiTutorChatService(prisma, context, embedFn, async (args) => {
      const result = await this.aiGateway.chat({
        tenantId: args.tenantId,
        input: {
          system: args.system,
          messages: args.messages,
          maxTokens: args.maxTokens,
        },
      });
      return {
        content: result.content,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
    });
    // Revisión humana del tutor: reutiliza el mismo embedFn porque las
    // correcciones se buscan contra el mismo espacio vectorial que los chunks.
    this.aiTutorReview = new AiTutorReviewService(prisma, context, embedFn);

    // mod.ai-grader: rúbrica + sugerencias IA con human-in-the-loop.
    // chatFn delega al AI Gateway con resolución de provider per-tenant.
    this.aiGraderRubric = new AiGraderRubricService(prisma, context);
    this.aiGraderSuggestion = new AiGraderSuggestionService(prisma, context, async (args) => {
      const result = await this.aiGateway.chat({
        tenantId: args.tenantId,
        input: {
          system: args.system,
          messages: args.messages,
          maxTokens: args.maxTokens,
        },
      });
      return {
        content: result.content,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        provider: result.provider,
        model: result.model,
      };
    });

    // mod.ai-content: chatFn delega al AI Gateway (mismo patrón ai-tutor /
    // ai-grader). El resolver lee la lección desde Prisma y aplana el
    // content JSON via extractLessonText reutilizado de mod.ai-tutor.
    const aiContentChatFn = async (args: {
      tenantId: string;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    }) => {
      const result = await this.aiGateway.chat({
        tenantId: args.tenantId,
        input: {
          system: args.system,
          messages: args.messages,
          maxTokens: args.maxTokens,
        },
      });
      return {
        content: result.content,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        provider: result.provider,
        model: result.model,
      };
    };
    const lessonPrisma = this.factory.getPrisma();
    const lessonResolver: AiContentLessonResolver = {
      resolve: async (args: { tenantId: string; lessonId: string }) => {
        const lesson = await lessonPrisma.modCoursesLesson.findFirst({
          where: { tenantId: args.tenantId, id: args.lessonId },
          select: { type: true, title: true, content: true },
        });
        if (!lesson) return null;
        const extracted = extractLessonText({
          type: lesson.type as LessonType,
          title: lesson.title,
          content: (lesson.content as Record<string, unknown>) ?? {},
        });
        return { text: extracted.text, title: lesson.title };
      },
    };
    const aiContentPublisher = {
      publish: async (
        tenantId: string,
        actorId: string | null,
        eventName: string,
        payload: Record<string, unknown>,
      ) => {
        const draftId = (payload as { draftId?: string }).draftId;
        await this.factory.getEventBus().publish({
          name: eventName,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            idempotencyKey: draftId ? `${eventName}:${draftId}` : `${eventName}:${cryptoRandom()}`,
          },
        });
      },
    };
    this.aiContent = new AiContentService(
      prisma,
      aiContentChatFn,
      lessonResolver,
      aiContentPublisher,
    );

    const certificatesModule = buildCertificatesModule(this.certificates);
    const aiContentModule = buildAiContentModule(this.aiContent);

    // mod.billing / mod.subscriptions / membresía: Stripe es configurable POR
    // TENANT desde Administración → Pagos (tenant_setting, cifrado), con
    // fallback a las envs de instancia si el tenant no configuró las suyas
    // (mismo patrón que SMTP). Los 3 services son SIEMPRE singletons — la
    // disponibilidad real de Stripe se decide per-tenant, per-llamada dentro
    // de `stripeFor`/`subscriptionsStripeFor` (StripeConfigMissingError se
    // propaga desde ahí cuando ni el tenant ni la instancia tienen key).
    // El 2º argumento es el candado `billing.allowGlobalStripeFallback`: con él
    // a `false`, un tenant sin credenciales propias NO hereda las de instancia
    // (en un pool multi-tenant heredarlas mete el dinero de sus alumnos en la
    // cuenta del operador). Se lee de `core_instance_setting`, tabla global sin
    // `tenant_id` — RLS no aplica —, y el resolutor lo cachea 60 s.
    const prismaForFlag = this.factory.getPrisma() as unknown as {
      instanceSetting: {
        findUnique(args: {
          where: { scope_key: { scope: string; key: string } };
        }): Promise<{ valueJson: unknown } | null>;
      };
    };
    this.stripeResolver = new TenantStripeResolverService(
      this.factory.getTenantConfig(),
      async () => {
        const row = await prismaForFlag.instanceSetting.findUnique({
          where: { scope_key: { scope: 'billing', key: 'allowGlobalStripeFallback' } },
        });
        // Ausente o cualquier cosa que no sea `false` → permitido (default seguro
        // para el self-hoster que actualiza y hoy cobra por env).
        return row?.valueJson !== false;
      },
    );
    // OJO con `??`: la plantilla del .env declara `STRIPE_WEBHOOK_SECRET=` y un
    // env_file convierte eso en CADENA VACÍA, no en undefined — con `??` el
    // respaldo no entraría. Por eso `||` sobre el valor ya recortado.
    this.globalStripeAdapter = this.tryBuildGlobalStripeAdapter();
    this.globalSubscriptionsStripeAdapter = this.tryBuildGlobalSubscriptionsStripeAdapter();
    if (!this.globalStripeAdapter && !this.globalSubscriptionsStripeAdapter) {
      this.pino.warn(
        {},
        'Sin credenciales Stripe de instancia (STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET) — ' +
          'mod.billing/mod.subscriptions siguen operativos: cada tenant puede configurar las ' +
          'suyas en Administración → Pagos.',
      );
    }

    const successUrlBase =
      process.env['BILLING_SUCCESS_URL_BASE'] ??
      `${process.env['AUTH_URL'] ?? 'http://localhost:3000'}/cursos`;
    const cancelUrlBase =
      process.env['BILLING_CANCEL_URL_BASE'] ??
      `${process.env['AUTH_URL'] ?? 'http://localhost:3000'}/cursos`;
    const urls: CheckoutUrlBuilder = {
      successUrl: (courseId) => `${successUrlBase}/${courseId}?paid=1`,
      cancelUrl: (courseId) => `${cancelUrlBase}/${courseId}?cancelled=1`,
    };

    const eventBus = this.factory.getEventBus();
    const publisher: BillingEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        // idempotencyKey derivado del orderId cuando aplique: si el outbox
        // dispatcher reintrega, downstream subscribers no duplican efecto.
        const orderId = (payload as { orderId?: string }).orderId;
        await eventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            idempotencyKey: orderId ? `${name}:${orderId}` : `${name}:${cryptoRandom()}`,
          },
        });
      },
    };
    const stripeFor: StripeAdapterResolver = (tenantId) => this.resolveStripeAdapter(tenantId);
    this.billing = new BillingService(prisma, stripeFor, publisher, urls);
    const billingModule = buildBillingModule(this.billing);

    // Publisher compartido por SubscriptionsService y MembershipService.
    const subsEventBus = this.factory.getEventBus();
    const subsPublisher: SubscriptionsEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const subId = (payload as { subscriptionId?: string }).subscriptionId;
        await subsEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            // Clave ÚNICA POR OCURRENCIA (no `${name}:${subId}` a secas): el
            // outbox dedupea PARA SIEMPRE por (tenantId, idempotencyKey), y una
            // sub transiciona el mismo estado varias veces en su vida (activated
            // tras payNow y MESES después tras un recovery; unpaid en dos
            // impagos distintos). Con la clave estable, la 2ª ocurrencia se
            // tragaba y el bridge no re-concedía/re-revocaba el acceso. El
            // dedupe real de reintentos de Stripe ya ocurre ANTES, en
            // handleWebhookEvent (PK stripe_event_id).
            idempotencyKey: `${name}:${subId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };

    const subsSuccessBase =
      process.env['SUBSCRIPTIONS_SUCCESS_URL_BASE'] ??
      `${process.env['AUTH_URL'] ?? 'http://localhost:3000'}/cuenta/suscripciones`;
    const subsCancelBase =
      process.env['SUBSCRIPTIONS_CANCEL_URL_BASE'] ??
      `${process.env['AUTH_URL'] ?? 'http://localhost:3000'}/cuenta/suscripciones`;
    const subsUrls: SubsCheckoutUrlBuilder = {
      successUrl: (courseId) => `${subsSuccessBase}?course=${courseId}&status=success`,
      cancelUrl: (courseId) => `${subsCancelBase}?course=${courseId}&status=cancel`,
    };

    const gracePeriodDays = Number(
      process.env['SUBSCRIPTIONS_GRACE_PERIOD_DAYS'] ?? DEFAULT_GRACE_PERIOD_DAYS,
    );
    const subscriptionsStripeFor: SubscriptionsStripeAdapterResolver = (tenantId) =>
      this.resolveSubscriptionsStripeAdapter(tenantId);
    // Catálogo curso → precios. mod.subscriptions no puede leer las tablas de
    // mod.billing (contrato modular), pero esta capa sí: es la que compone los
    // dos. Sin esto, el `stripePriceId` del body del alumno se aceptaba con
    // solo comprobar que existiera y fuera recurrente, así que cualquiera podía
    // suscribirse a un curso caro al precio de la membresía más barata.
    const subsCoursePrices: SubsCoursePriceCatalog = async (tenantId, courseId) => {
      // `prisma` de arriba viaja como `never` hacia los services de módulo;
      // aquí hace falta el cliente tipado de verdad para leer el catálogo.
      const productos = await this.factory.getPrisma().modBillingProduct.findMany({
        where: { tenantId, courseId, active: true },
        select: { stripePriceId: true },
      });
      return productos.map((producto) => producto.stripePriceId);
    };

    this.subscriptions = new SubscriptionsService(
      prisma,
      subscriptionsStripeFor,
      subsPublisher,
      subsUrls,
      Number.isFinite(gracePeriodDays) && gracePeriodDays > 0
        ? gracePeriodDays
        : DEFAULT_GRACE_PERIOD_DAYS,
      subsCoursePrices,
    );
    const subscriptionsModule = buildSubscriptionsModule(this.subscriptions);

    // Membresía (página pública /unete): config y planes funcionan SIN Stripe
    // (el admin puede dejarlo todo listo antes de configurar la key); el
    // checkout lanza StripeConfigMissingError → 503 si falta.
    this.membership = new MembershipService(prisma, subscriptionsStripeFor, subsPublisher);

    // mod.referrals: programa de referidos de la membresía. No depende de
    // Stripe (consume eventos de mod.subscriptions vía bridge); siempre se
    // inicializa — el gate real es config.active per-tenant.
    const referralsEventBus = this.factory.getEventBus();
    const referralsPublisher: ReferralsEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const entityId =
          (payload as { commissionId?: string }).commissionId ??
          (payload as { referralId?: string }).referralId ??
          (payload as { payoutId?: string }).payoutId;
        await referralsEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            // Por ocurrencia (mismo criterio que subscriptions): el outbox
            // dedupea para siempre y una entidad puede re-emitir estados.
            idempotencyKey: `${name}:${entityId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };
    const referralsPrisma = this.factory.getPrisma();
    this.referrals = new ReferralsService(
      prisma,
      referralsPublisher,
      // Lookup de email para el anti-auto-referido: el módulo no lee `user`,
      // lo resuelve el host (misma razón que UserProvisioner en membresía).
      async (tenantId, userId) => {
        const user = await referralsPrisma.user.findFirst({
          where: { id: userId, tenantId },
          select: { email: true },
        });
        return user?.email ?? null;
      },
    );
    const referralsModule = buildReferralsModule(this.referrals);

    // mod.surveys: encuestas anónimas con NPS (bloque 2). El secreto del hash
    // anónimo debe ser estable entre deploys: SURVEYS_HASH_SECRET dedicado con
    // fallback a AUTH_SECRET (cambiarlo rompería el dedupe de "ya respondió").
    const surveysEventBus = this.factory.getEventBus();
    const surveysPublisher: SurveysEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const entityId = (payload as { surveyId?: string }).surveyId;
        await surveysEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            // Por ocurrencia (mismo criterio que referrals): el outbox dedupea
            // para siempre y una encuesta emite varios response.submitted.
            idempotencyKey: `${name}:${entityId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };
    const surveysHashSecret =
      process.env['SURVEYS_HASH_SECRET']?.trim() || process.env['AUTH_SECRET']?.trim() || '';
    this.surveys = new SurveysService(prisma, surveysPublisher, surveysHashSecret);
    const surveysModule = buildSurveysModule();

    // mod.resources: biblioteca de recursos (bloque 4).
    const resourcesEventBus = this.factory.getEventBus();
    const resourcesPublisher: ResourcesEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const entityId = (payload as { resourceId?: string }).resourceId;
        await resourcesEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            idempotencyKey: `${name}:${entityId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };
    this.resources = new ResourcesService(prisma, resourcesPublisher);
    const resourcesModule = buildResourcesModule();

    // mod.gamification: puntos, niveles y retos (bloque 1).
    const gamificationEventBus = this.factory.getEventBus();
    const gamificationPublisher: GamificationEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const entityId =
          (payload as { sourceKey?: string; submissionId?: string }).sourceKey ??
          (payload as { submissionId?: string }).submissionId;
        await gamificationEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            idempotencyKey: `${name}:${entityId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };
    this.gamification = new GamificationService(prisma, gamificationPublisher);
    const gamificationModule = buildGamificationModule();

    // mod.messaging: salas por espacio, DMs y canal alumno↔profesores.
    // El módulo es puro: los ports (espacios de community, usuarios, staff)
    // los implementa el host aquí; el realtime lo publica el controller.
    const messagingEventBus = this.factory.getEventBus();
    const messagingPublisher: MessagingEventPublisher = {
      publish: async (tenantId, actorId, name, payload) => {
        const entityId =
          (payload as { messageId?: string }).messageId ??
          (payload as { conversationId?: string }).conversationId;
        await messagingEventBus.publish({
          name,
          version: 1,
          data: payload as never,
          metadata: {
            tenantId,
            userId: actorId ?? undefined,
            timestamp: new Date().toISOString(),
            traceId: cryptoRandom(),
            // Por ocurrencia: el outbox dedupea por (tenantId, idempotencyKey)
            // para siempre y una entidad puede re-emitir estados.
            idempotencyKey: `${name}:${entityId ?? 'x'}:${cryptoRandom()}`,
          },
        });
      },
    };
    const messagingPrisma = this.factory.getPrisma();
    this.messaging = new MessagingService(
      prisma,
      messagingPublisher,
      // Espacios de mod.community vía su service público (ADR-016, vía A).
      async (tenantId) => {
        if (!this.community) return [];
        const spaces = await this.community.listSpaces(tenantId);
        return spaces.map((s) => ({
          id: s.id,
          slug: s.slug,
          title: s.title,
          icon: s.icon,
          color: s.color,
          sortOrder: s.sortOrder,
        }));
      },
      // Nombre+avatar de usuarios del tenant: el módulo no lee `user`.
      async (tenantId, ids) => {
        if (ids.length === 0) return [];
        const users = await messagingPrisma.user.findMany({
          where: { id: { in: ids }, tenantId, deletedAt: null },
          select: { id: true, name: true, email: true, avatarUrl: true },
        });
        return users.map((u) => ({
          id: u.id,
          name: u.name ?? u.email ?? null,
          avatarUrl: u.avatarUrl,
        }));
      },
      // IDs del staff (formador/admins) para el canal de profesores.
      async (tenantId) => {
        const rows = await messagingPrisma.user.findMany({
          where: {
            tenantId,
            deletedAt: null,
            roles: { some: { role: { name: { in: [...MESSAGING_STAFF_ROLES] } } } },
          },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      },
    );
    const messagingModule = buildMessagingModule(this.messaging);

    // mod.payment-connections: agregador read-only multi-cuenta. NO se gatea por
    // env (las API keys son per-conexión, cifradas en tenant_setting vía el
    // config service). El SDK de Stripe se carga perezosamente la primera vez
    // que se usa una conexión, así boot/test no requieren `stripe`.
    let pcStripeCtor: (new (key: string, opts?: unknown) => unknown) | undefined;
    const pcAdapterFactory: PaymentReadAdapterFactory = (provider, credentials) => {
      if (provider === 'stripe') {
        if (!pcStripeCtor) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require('stripe');
          pcStripeCtor = mod.default ?? mod;
        }
        return new StripeReadSdkAdapter(
          (credentials as StripeCredentials).apiKey,
          pcStripeCtor as never,
        );
      }
      if (provider === 'paypal') {
        // PayPal usa fetch global (Node 22) — sin SDK que cargar.
        return new PayPalReadSdkAdapter(credentials as PayPalCredentials);
      }
      if (provider === 'woocommerce') {
        // WooCommerce REST API vía fetch global — sin SDK.
        return new WooCommerceReadSdkAdapter(credentials as WooCommerceCredentials);
      }
      throw new Error(`Proveedor de pago no soportado: ${provider}`);
    };
    const pcPrisma = this.factory.getPrisma();
    const pcUserDirectory: PaymentConnectionsUserDirectoryPort = {
      // Match case-insensitive por email contra la tabla user del tenant.
      // `emails` ya viene normalizado (lowercase) desde el service.
      findByNormalizedEmails: async (tenantId, emails) => {
        if (emails.length === 0) return [];
        return pcPrisma.$queryRaw<
          Array<{
            id: string;
            email: string;
            name: string | null;
            status: string;
            avatarUrl: string | null;
          }>
        >`
          SELECT id, email, name, status, avatar_url AS "avatarUrl"
          FROM "user"
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
            AND lower(email) IN (${Prisma.join(emails)})
        `;
      },
    };
    this.paymentConnections = new PaymentConnectionsService(
      prisma,
      this.factory.getTenantConfig() as unknown as PaymentConnectionsConfigPort,
      pcAdapterFactory,
      pcUserDirectory,
    );
    const paymentConnectionsModule = buildPaymentConnectionsModule(this.paymentConnections);
    this.paymentTiers = new PaymentTiersService(prisma);
    // Espejo del histórico de pedidos de la tienda externa (fase A: solo lee).
    this.orderMirror = new OrderMirrorService(prisma);

    await this.registry.register([
      helloWorldModule,
      coursesModule,
      learningModule,
      certificatesModule,
      assessmentsModule,
      communityModule,
      themingModule,
      zoomLiveModule,
      fundaeModule,
      aiTutorModule,
      aiGraderModule,
      aiContentModule,
      wpSsoModule,
      billingModule,
      subscriptionsModule,
      paymentConnectionsModule,
      // Grupos de acceso: depende (hard) de mod.courses y mod.learning. El host
      // NestJS del módulo vive en ./access-groups/ (ADR-011/015). El orden del
      // array da igual: register() hace sort topológico por dependencias.
      buildAccessGroupsModule(),
      // Depende (hard) de mod.payment-connections y mod.access-groups (F6) —
      // ambos registrados en este mismo batch. El host NestJS del módulo vive
      // en ./member-registration/ (ADR-011/015).
      buildMemberRegistrationModule(),
      referralsModule,
      messagingModule,
      surveysModule,
      resourcesModule,
      gamificationModule,
    ]);

    await this.persistManifests();
    await this.healCoreModulesEnabled();

    this.pino.log(
      { modules: this.registry.listModules().map((m) => m.manifest.name) },
      'Module registry inicializado',
    );
  }

  /**
   * Self-heal post-boot: módulos categoría 'core' (theming, courses, learning,
   * etc.) que estén `enabled=false` en algún tenant se re-habilitan.
   * `TenantModulesService.disable` los rechaza desde alpha.10 con
   * CORE_MODULE_NOT_DISABLEABLE, pero deploys antiguos pueden haber dejado
   * filas con enabled=false. Este healer corrige el estado existente sin
   * necesidad de migración manual.
   */
  private async healCoreModulesEnabled(): Promise<void> {
    if (!this.registry) return;
    const prisma = this.factory.getPrisma();
    const coreNames = this.registry
      .listModules()
      .filter((m) => m.manifest.category === 'core')
      .map((m) => m.manifest.name);
    if (coreNames.length === 0) return;

    // Self-heal cross-tenant de arranque: acceso global sancionado.
    const result = await runSanctionedGlobalAccess(() =>
      prisma.tenantModule.updateMany({
        where: {
          enabled: false,
          module: { name: { in: coreNames } },
        },
        data: { enabled: true },
      }),
    );
    if (result.count > 0) {
      this.pino.log(
        { healed: result.count, coreModules: coreNames },
        'Re-habilitados módulos core que estaban disabled (self-heal post-boot)',
      );
    }
  }

  /**
   * Hace upsert por nombre en `module` con los manifests cargados al boot.
   * Idempotente: actualiza versión / displayName / description si cambian
   * entre deploys. La fila persiste el catálogo de módulos disponibles que
   * usa el panel de tenant_admin para permitir activar/desactivar.
   */
  private async persistManifests(): Promise<void> {
    if (!this.registry) return;
    const prisma = this.factory.getPrisma();
    for (const mod of this.registry.listModules()) {
      const m = mod.manifest;
      await prisma.module.upsert({
        where: { name: m.name },
        update: {
          version: m.version,
          displayName: m.displayName,
          description: m.description ?? null,
          enabledByDefault: true,
          manifest: m as unknown as object,
        },
        create: {
          name: m.name,
          version: m.version,
          displayName: m.displayName,
          description: m.description ?? null,
          enabledByDefault: true,
          manifest: m as unknown as object,
        },
      });
    }
  }

  /**
   * Adapter Stripe de mod.billing para UN tenant: sus credenciales propias
   * (Administración → Pagos) si las tiene, si no el fallback global de
   * instancia ya memoizado al boot. Lanza StripeConfigMissingError si ni el
   * tenant ni la instancia tienen nada configurado — la captura
   * BillingErrorFilter (@Catch(BillingError)) y responde 503.
   */
  private async resolveStripeAdapter(tenantId: string): Promise<StripeAdapter> {
    if (!this.stripeResolver) throw new Error('ModuleRegistry no está inicializado');
    const resolved = await this.stripeResolver.resolve(tenantId);
    if (!resolved) throw new BillingStripeConfigMissingError('secretKey');
    if (resolved.source === 'global' && this.globalStripeAdapter) return this.globalStripeAdapter;
    return this.buildStripeAdapter(resolved.credentials);
  }

  /** Igual que resolveStripeAdapter pero para mod.subscriptions/membresía. */
  private async resolveSubscriptionsStripeAdapter(
    tenantId: string,
  ): Promise<SubscriptionsStripeAdapter> {
    if (!this.stripeResolver) throw new Error('ModuleRegistry no está inicializado');
    const resolved = await this.stripeResolver.resolve(tenantId);
    if (!resolved) throw new SubscriptionsStripeConfigMissingError('secretKey');
    if (resolved.source === 'global' && this.globalSubscriptionsStripeAdapter) {
      return this.globalSubscriptionsStripeAdapter;
    }
    return this.buildSubscriptionsStripeAdapter(resolved.credentials);
  }

  private buildStripeAdapter(credentials: BillingStripeCredentials): StripeAdapter {
    // Carga perezosa de Stripe SDK — evita romper en NODE_ENV=test si no
    // está instalado (vitest unit no lo necesita).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require('stripe').default ?? require('stripe');
    return new StripeSdkAdapter(credentials.secretKey, credentials.webhookSecret, StripeCtor);
  }

  private buildSubscriptionsStripeAdapter(
    credentials: BillingStripeCredentials,
  ): SubscriptionsStripeAdapter {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StripeCtor = require('stripe').default ?? require('stripe');
    return new SubscriptionsStripeSdkAdapter(
      credentials.secretKey,
      credentials.subscriptionsWebhookSecret || credentials.webhookSecret,
      StripeCtor,
    );
  }

  private tryBuildGlobalStripeAdapter(): StripeAdapter | undefined {
    const secretKey = process.env['STRIPE_SECRET_KEY']?.trim();
    const webhookSecret =
      process.env['STRIPE_WEBHOOK_SECRET']?.trim() ||
      process.env['SUBSCRIPTIONS_WEBHOOK_SECRET']?.trim() ||
      undefined;
    if (!secretKey || !webhookSecret) return undefined;
    return this.buildStripeAdapter({ secretKey, webhookSecret });
  }

  private tryBuildGlobalSubscriptionsStripeAdapter(): SubscriptionsStripeAdapter | undefined {
    const secretKey = process.env['STRIPE_SECRET_KEY']?.trim();
    const webhookSecret =
      process.env['SUBSCRIPTIONS_WEBHOOK_SECRET']?.trim() ||
      process.env['STRIPE_WEBHOOK_SECRET']?.trim() ||
      undefined;
    if (!secretKey || !webhookSecret) return undefined;
    return this.buildSubscriptionsStripeAdapter({ secretKey, webhookSecret });
  }

  /** Expone el registry para uso de servicios admin (TenantModulesService). */
  getRegistry() {
    if (!this.registry) throw new Error('ModuleRegistry no está inicializado');
    return this.registry;
  }

  getCoursesService(): CoursesService {
    if (!this.courses) throw new Error('ModuleRegistry no está inicializado');
    return this.courses;
  }

  getLearningService(): LearningService {
    if (!this.learning) throw new Error('ModuleRegistry no está inicializado');
    return this.learning;
  }

  getLearningPathsService(): LearningPathsService {
    if (!this.learningPaths) throw new Error('ModuleRegistry no está inicializado');
    return this.learningPaths;
  }

  getCertificatesService(): CertificatesService {
    if (!this.certificates) throw new Error('ModuleRegistry no está inicializado');
    return this.certificates;
  }

  getAssessmentsService(): AssessmentsService {
    if (!this.assessments) throw new Error('ModuleRegistry no está inicializado');
    return this.assessments;
  }

  getCommunityService(): CommunityService {
    if (!this.community) throw new Error('ModuleRegistry no está inicializado');
    return this.community;
  }

  getThemingService(): ThemingService {
    if (!this.theming) throw new Error('ModuleRegistry no está inicializado');
    return this.theming;
  }

  getZoomLiveService(): ZoomLiveService {
    if (!this.zoomLive) throw new Error('ModuleRegistry no está inicializado');
    return this.zoomLive;
  }

  getFundaeService(): FundaeService {
    if (!this.fundae) throw new Error('ModuleRegistry no está inicializado');
    return this.fundae;
  }

  getFundaeCompanyService(): FundaeCompanyService {
    if (!this.fundaeCompanies) throw new Error('ModuleRegistry no está inicializado');
    return this.fundaeCompanies;
  }

  getFundaeRlptService(): FundaeRlptService {
    if (!this.fundaeRlpt) throw new Error('ModuleRegistry no está inicializado');
    return this.fundaeRlpt;
  }

  getFundaeGroupService(): FundaeGroupService {
    if (!this.fundaeGroups) throw new Error('ModuleRegistry no está inicializado');
    return this.fundaeGroups;
  }

  getFundaeGroupParticipantService(): FundaeGroupParticipantService {
    if (!this.fundaeGroupParticipants) throw new Error('ModuleRegistry no está inicializado');
    return this.fundaeGroupParticipants;
  }

  getScormService(): ScormService {
    if (!this.scorm) throw new Error('ModuleRegistry no está inicializado');
    return this.scorm;
  }

  /**
   * Devuelve el indexer del tutor IA o null si el módulo no está activo.
   * Útil para bridges (course.published) que no quieren acoplarse fuerte:
   * si el módulo no está, no fuerzan el suscriptor.
   */
  getAiTutorIndexerServiceOrNull(): AiTutorIndexerService | null {
    return this.aiTutorIndexer ?? null;
  }

  getAiTutorChatService(): AiTutorChatService {
    if (!this.aiTutorChat) throw new Error('ModuleRegistry no está inicializado');
    return this.aiTutorChat;
  }

  getAiTutorReviewService(): AiTutorReviewService {
    if (!this.aiTutorReview) throw new Error('ModuleRegistry no está inicializado');
    return this.aiTutorReview;
  }

  getAiGraderRubricService(): AiGraderRubricService {
    if (!this.aiGraderRubric) throw new Error('ModuleRegistry no está inicializado');
    return this.aiGraderRubric;
  }

  getAiGraderSuggestionService(): AiGraderSuggestionService {
    if (!this.aiGraderSuggestion) throw new Error('ModuleRegistry no está inicializado');
    return this.aiGraderSuggestion;
  }

  /**
   * ¿Está el módulo activo para ese tenant? Mismo criterio que
   * `ModuleAccessInterceptor` (fila de `tenant_module`, y si no hay,
   * `enabledByDefault` del catálogo), pero utilizable FUERA del path HTTP.
   *
   * Existe porque desactivar un módulo no apaga el bus de eventos: las
   * suscripciones se hacen en `onRegister`, una sola vez por proceso y sin
   * tenant, y `onDisable` no desuscribe nada. Sin esta comprobación, un tenant
   * que apaga el módulo dejaría de ver la UI pero seguiría acumulando datos.
   */
  async isModuleEnabledForTenant(tenantId: string, moduleName: string): Promise<boolean> {
    const cacheKey = `${tenantId}::${moduleName}`;
    const cached = this.moduleEnabledCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.enabled;

    const prisma = this.factory.getPrisma();
    const row = await prisma.module.findUnique({
      where: { name: moduleName },
      include: { tenantModules: { where: { tenantId } } },
    });
    // Sin fila de catálogo todavía (boot a medias): no bloquear.
    const enabled = row ? (row.tenantModules[0]?.enabled ?? row.enabledByDefault) : true;
    this.moduleEnabledCache.set(cacheKey, {
      enabled,
      expiresAt: now + MODULE_ENABLED_CACHE_TTL_MS,
    });
    return enabled;
  }

  getAiContentService(): AiContentService {
    if (!this.aiContent) throw new Error('mod.ai-content no está inicializado');
    return this.aiContent;
  }

  // Los 3 getters de abajo SIEMPRE devuelven el service — Stripe se resuelve
  // per-tenant, per-llamada dentro de cada método (stripeFor), no al obtener
  // el service. El `StripeConfigMissingError` propio de cada módulo (no un
  // `Error` plano) sale de ahí — son BillingError/SubscriptionsError, así que
  // BillingErrorFilter/SubscriptionsErrorFilter (@Catch(...Error)) las mapean
  // a un 503 con mensaje útil.
  getBillingService(): BillingService {
    if (!this.billing) throw new Error('ModuleRegistry no está inicializado');
    return this.billing;
  }

  getSubscriptionsService(): SubscriptionsService {
    if (!this.subscriptions) throw new Error('ModuleRegistry no está inicializado');
    return this.subscriptions;
  }

  /**
   * Como `getSubscriptionsService` pero devuelve null en vez de lanzar si el
   * registry aún no completó el boot (mismo criterio defensivo que el resto
   * de getters de esta clase). Lo usan los endpoints read-only del alumno.
   */
  getSubscriptionsServiceOrNull(): SubscriptionsService | null {
    return this.subscriptions ?? null;
  }

  /** Membresía (página pública /unete). SIEMPRE inicializado tras el boot. */
  getMembershipService(): MembershipService {
    if (!this.membership) {
      throw new Error('MembershipService no está inicializado (boot incompleto).');
    }
    return this.membership;
  }

  getPaymentConnectionsService(): PaymentConnectionsService {
    if (!this.paymentConnections) {
      throw new Error('mod.payment-connections no está inicializado');
    }
    return this.paymentConnections;
  }

  getPaymentTiersService(): PaymentTiersService {
    if (!this.paymentTiers) {
      throw new Error('mod.payment-connections (tiers) no está inicializado');
    }
    return this.paymentTiers;
  }

  getOrderMirrorService(): OrderMirrorService {
    if (!this.orderMirror) {
      throw new Error('mod.payment-connections (espejo de pedidos) no está inicializado');
    }
    return this.orderMirror;
  }

  /** Programa de referidos. SIEMPRE inicializado tras el boot (sin gate de env). */
  getReferralsService(): ReferralsService {
    if (!this.referrals) {
      throw new Error('mod.referrals no está inicializado (boot incompleto).');
    }
    return this.referrals;
  }

  /** Encuestas y NPS. SIEMPRE inicializado tras el boot (sin gate de env). */
  getSurveysService(): SurveysService {
    if (!this.surveys) {
      throw new Error('mod.surveys no está inicializado (boot incompleto).');
    }
    return this.surveys;
  }

  /** Biblioteca de recursos. SIEMPRE inicializado tras el boot (sin gate de env). */
  getResourcesService(): ResourcesService {
    if (!this.resources) {
      throw new Error('mod.resources no está inicializado (boot incompleto).');
    }
    return this.resources;
  }

  /** Puntos, niveles y retos. SIEMPRE inicializado tras el boot (sin gate de env). */
  getGamificationService(): GamificationService {
    if (!this.gamification) {
      throw new Error('mod.gamification no está inicializado (boot incompleto).');
    }
    return this.gamification;
  }

  getMessagingService(): MessagingService {
    if (!this.messaging) {
      throw new Error('mod.messaging no está inicializado (boot incompleto).');
    }
    return this.messaging;
  }

  async recoverOutbox(): Promise<{
    processed: number;
    failed: number;
    undelivered: number;
    deduplicated: number;
  }> {
    return this.factory.getEventBus().recoverPending();
  }

  /**
   * Re-entrega los eventos que no llegaron a ningún handler y que ahora sí
   * tienen subscriber. Lo llama el OutboxRecoveryWorker en cada barrido.
   */
  async replayUndeliveredOutbox(): Promise<{ replayed: number; failed: number }> {
    return this.factory.getEventBus().replayUndelivered();
  }
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
