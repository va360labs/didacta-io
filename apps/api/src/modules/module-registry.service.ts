import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '@learnship/core-registry';
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

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly pino: PinoLogger,
  ) {}

  async onModuleInit() {
    const context = this.factory.build();
    this.registry = new ModuleRegistry({ coreVersion: CORE_VERSION, context });

    await this.registry.register([helloWorldModule, coursesModule, learningModule]);

    this.courses = new CoursesService(this.factory.getPrisma() as never, context);
    this.learning = new LearningService(this.factory.getPrisma() as never, context);

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

  isModuleEnabledForTenant(_tenantId: string, _moduleName: string): boolean {
    return true;
  }
}
