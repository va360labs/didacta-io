import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRegistry } from '@learnship/core-registry';
import { coursesModule, CoursesService } from '@learnship/mod-courses';
import { helloWorldModule } from '@learnship/mod-hello-world';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from './module-context.factory';

const CORE_VERSION = '1.0.0';

/**
 * Registry runtime de la API: carga los módulos de la fase actual,
 * resuelve el ciclo de vida y expone los services como providers DI.
 *
 * Cuando llegue un sistema de descubrimiento desde filesystem (ADR futuro),
 * este wrapper se reemplaza. Por ahora la lista es explícita.
 */
@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private registry?: ModuleRegistry;
  private courses?: CoursesService;

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly pino: PinoLogger,
  ) {}

  async onModuleInit() {
    const context = this.factory.build();
    this.registry = new ModuleRegistry({
      coreVersion: CORE_VERSION,
      context,
    });

    await this.registry.register([helloWorldModule, coursesModule]);

    // Service de mod.courses cableado al PrismaClient extendido del API.
    this.courses = new CoursesService(this.factory.getPrisma() as never, context);

    this.pino.log(
      { modules: this.registry.listModules().map((m) => m.manifest.name) },
      'Module registry inicializado',
    );
  }

  getCoursesService(): CoursesService {
    if (!this.courses) throw new Error('ModuleRegistry no está inicializado');
    return this.courses;
  }

  isModuleEnabledForTenant(_tenantId: string, _moduleName: string): boolean {
    // TODO: leer de tenant_module en BD. Por ahora todos los registrados están enabled.
    return true;
  }
}
