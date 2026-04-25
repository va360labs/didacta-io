import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '@learnship/core-registry';
import { buildCertificatesModule, CertificatesService } from '@learnship/mod-certificates';
import { coursesModule, CoursesService } from '@learnship/mod-courses';
import { helloWorldModule } from '@learnship/mod-hello-world';
import { learningModule, LearningService } from '@learnship/mod-learning';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from './module-context.factory';

const CORE_VERSION = '1.0.0';

@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private registry?: ModuleRegistry;
  private courses?: CoursesService;
  private learning?: LearningService;
  private certificates?: CertificatesService;

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly pino: PinoLogger,
  ) {}

  async onModuleInit() {
    const context = this.factory.build();
    this.registry = new ModuleRegistry({ coreVersion: CORE_VERSION, context });

    const prisma = this.factory.getPrisma() as never;
    this.courses = new CoursesService(prisma, context);
    this.learning = new LearningService(prisma, context);
    this.certificates = new CertificatesService(prisma, context);

    const certificatesModule = buildCertificatesModule(this.certificates);

    await this.registry.register([
      helloWorldModule,
      coursesModule,
      learningModule,
      certificatesModule,
    ]);

    this.pino.log(
      { modules: this.registry.listModules().map((m) => m.manifest.name) },
      'Module registry inicializado',
    );
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

  isModuleEnabledForTenant(_tenantId: string, _moduleName: string): boolean {
    return true;
  }

  async recoverOutbox(): Promise<{ processed: number; failed: number }> {
    return this.factory.getEventBus().recoverPending();
  }
}
