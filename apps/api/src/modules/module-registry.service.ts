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
  StripeSdkAdapter,
  type BillingEventPublisher,
  type CheckoutUrlBuilder,
  type StripeAdapter,
} from '@didacta/mod-billing';
import {
  MembershipService,
  SubscriptionsService,
  SubscriptionsStripeSdkAdapter,
  buildSubscriptionsModule,
  DEFAULT_GRACE_PERIOD_DAYS,
  type CheckoutUrlBuilder as SubsCheckoutUrlBuilder,
  type SubscriptionsEventPublisher,
  type SubscriptionsStripeAdapter,
} from '@didacta/mod-subscriptions';
import {
  buildReferralsModule,
  ReferralsService,
  type ReferralsEventPublisher,
} from '@didacta/mod-referrals';
import {
  PaymentConnectionsService,
  PaymentTiersService,
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
} from '@didacta/mod-learning';
import { themingModule, ThemingService } from '@didacta/mod-theming';
import { zoomLiveModule, ZoomLiveService } from '@didacta/mod-zoom-live';
import { aiTutorModule, AiTutorChatService, AiTutorIndexerService } from '@didacta/mod-ai-tutor';
import {
  aiGraderModule,
  AiGraderRubricService,
  AiGraderSuggestionService,
} from '@didacta/mod-ai-grader';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { ModuleContextFactory } from './module-context.factory';

const CORE_VERSION = '1.0.0';

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
  private aiGraderRubric?: AiGraderRubricService;
  private aiGraderSuggestion?: AiGraderSuggestionService;
  private aiContent?: AiContentService;
  private billing?: BillingService;
  private stripeAdapter?: StripeAdapter;
  private subscriptions?: SubscriptionsService;
  private membership?: MembershipService;
  private subscriptionsStripeAdapter?: SubscriptionsStripeAdapter;
  private paymentConnections?: PaymentConnectionsService;
  private paymentTiers?: PaymentTiersService;
  private referrals?: ReferralsService;

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
    this.learning = new LearningService(prisma, context);
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

    // mod.billing: el adapter Stripe se construye solo si las ENVs están
    // presentes. Sin Stripe configurado, el módulo no expone su service —
    // los endpoints `/modules/billing/*` devuelven 503 vía ConfigMissing.
    const stripeKey = process.env['STRIPE_SECRET_KEY'];
    const stripeWebhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];
    if (stripeKey && stripeWebhookSecret) {
      // Carga perezosa de Stripe SDK — evita romper en NODE_ENV=test si no
      // está instalado (vitest unit no lo necesita).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const StripeCtor = require('stripe').default ?? require('stripe');
      this.stripeAdapter = new StripeSdkAdapter(stripeKey, stripeWebhookSecret, StripeCtor);

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

      this.billing = new BillingService(prisma, this.stripeAdapter, publisher, urls);
    } else {
      this.pino.warn(
        {},
        'STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET ausentes — mod.billing sin service. Endpoints /modules/billing devolverán 503.',
      );
    }

    const billingModuleOrNull = this.billing ? buildBillingModule(this.billing) : null;

    // mod.subscriptions: comparte STRIPE_SECRET_KEY con mod.billing (un solo
    // Stripe account por instancia). Webhook secret es independiente — Stripe
    // permite múltiples endpoints firmados con secrets distintos.
    const subscriptionsWebhookSecret =
      process.env['SUBSCRIPTIONS_WEBHOOK_SECRET'] ?? stripeWebhookSecret;
    // Publisher compartido por SubscriptionsService y MembershipService.
    // Se construye SIEMPRE (no depende de Stripe): la membresía necesita
    // publicar aunque el checkout esté deshabilitado por falta de key.
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
    if (stripeKey && subscriptionsWebhookSecret) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const StripeCtor = require('stripe').default ?? require('stripe');
      this.subscriptionsStripeAdapter = new SubscriptionsStripeSdkAdapter(
        stripeKey,
        subscriptionsWebhookSecret,
        StripeCtor,
      );

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
      this.subscriptions = new SubscriptionsService(
        prisma,
        this.subscriptionsStripeAdapter,
        subsPublisher,
        subsUrls,
        Number.isFinite(gracePeriodDays) && gracePeriodDays > 0
          ? gracePeriodDays
          : DEFAULT_GRACE_PERIOD_DAYS,
      );
    } else {
      this.pino.warn(
        {},
        'STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET ausentes — mod.subscriptions sin service. Endpoints /modules/subscriptions devolverán 503.',
      );
    }

    // Membresía (página pública /unete): config y planes funcionan SIN Stripe
    // (el admin puede dejarlo todo listo antes de configurar la key); el
    // checkout lanza StripeConfigMissingError → 503 si falta el adapter.
    this.membership = new MembershipService(
      prisma,
      this.subscriptionsStripeAdapter ?? null,
      subsPublisher,
    );

    const subscriptionsModuleOrNull = this.subscriptions
      ? buildSubscriptionsModule(this.subscriptions)
      : null;

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
      ...(billingModuleOrNull ? [billingModuleOrNull] : []),
      ...(subscriptionsModuleOrNull ? [subscriptionsModuleOrNull] : []),
      paymentConnectionsModule,
      referralsModule,
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

    const result = await prisma.tenantModule.updateMany({
      where: {
        enabled: false,
        module: { name: { in: coreNames } },
      },
      data: { enabled: true },
    });
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

  getAiGraderRubricService(): AiGraderRubricService {
    if (!this.aiGraderRubric) throw new Error('ModuleRegistry no está inicializado');
    return this.aiGraderRubric;
  }

  getAiGraderSuggestionService(): AiGraderSuggestionService {
    if (!this.aiGraderSuggestion) throw new Error('ModuleRegistry no está inicializado');
    return this.aiGraderSuggestion;
  }

  isModuleEnabledForTenant(_tenantId: string, _moduleName: string): boolean {
    return true;
  }

  getAiContentService(): AiContentService {
    if (!this.aiContent) throw new Error('mod.ai-content no está inicializado');
    return this.aiContent;
  }

  getBillingService(): BillingService {
    if (!this.billing) {
      throw new Error(
        'mod.billing no está inicializado. Configura STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET.',
      );
    }
    return this.billing;
  }

  getStripeAdapter(): StripeAdapter {
    if (!this.stripeAdapter) {
      throw new Error(
        'StripeAdapter no está inicializado. Configura STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET.',
      );
    }
    return this.stripeAdapter;
  }

  getSubscriptionsService(): SubscriptionsService {
    if (!this.subscriptions) {
      throw new Error(
        'mod.subscriptions no está inicializado. Configura STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET (o SUBSCRIPTIONS_WEBHOOK_SECRET).',
      );
    }
    return this.subscriptions;
  }

  /**
   * Como `getSubscriptionsService` pero devuelve null en vez de lanzar cuando el
   * módulo no está inicializado (p. ej. un despliegue que usa pagos EXTERNOS vía
   * mod.payment-connections y no tiene el Stripe propio de Didacta configurado).
   * Lo usan los endpoints read-only del alumno para degradar a "sin suscripciones"
   * en lugar de responder 500.
   */
  getSubscriptionsServiceOrNull(): SubscriptionsService | null {
    return this.subscriptions ?? null;
  }

  /**
   * Membresía (página pública /unete). SIEMPRE inicializado tras el boot:
   * config y planes no requieren Stripe; el checkout falla con 503 si falta.
   */
  getMembershipService(): MembershipService {
    if (!this.membership) {
      throw new Error('MembershipService no está inicializado (boot incompleto).');
    }
    return this.membership;
  }

  getSubscriptionsStripeAdapter(): SubscriptionsStripeAdapter {
    if (!this.subscriptionsStripeAdapter) {
      throw new Error(
        'SubscriptionsStripeAdapter no está inicializado. Configura STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET.',
      );
    }
    return this.subscriptionsStripeAdapter;
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

  /** Programa de referidos. SIEMPRE inicializado tras el boot (sin gate de env). */
  getReferralsService(): ReferralsService {
    if (!this.referrals) {
      throw new Error('mod.referrals no está inicializado (boot incompleto).');
    }
    return this.referrals;
  }

  async recoverOutbox(): Promise<{ processed: number; failed: number }> {
    return this.factory.getEventBus().recoverPending();
  }
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
