import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '@didacta/core-registry';
import { assessmentsModule, AssessmentsService } from '@didacta/mod-assessments';
import { buildCertificatesModule, CertificatesService } from '@didacta/mod-certificates';
import { communityModule, CommunityService } from '@didacta/mod-community';
import { coursesModule, CoursesService } from '@didacta/mod-courses';
import { helloWorldModule } from '@didacta/mod-hello-world';
import {
  fundaeModule,
  FundaeCompanyService,
  FundaeGroupParticipantService,
  FundaeGroupService,
  FundaeRlptService,
  FundaeService,
} from '@didacta/mod-fundae';
import { learningModule, LearningService, ScormService } from '@didacta/mod-learning';
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

    const certificatesModule = buildCertificatesModule(this.certificates);

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
    ]);

    await this.persistManifests();

    this.pino.log(
      { modules: this.registry.listModules().map((m) => m.manifest.name) },
      'Module registry inicializado',
    );
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

  async recoverOutbox(): Promise<{ processed: number; failed: number }> {
    return this.factory.getEventBus().recoverPending();
  }
}
