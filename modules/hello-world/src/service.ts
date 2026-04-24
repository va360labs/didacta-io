import type { ModuleContext } from '@learnship/core-kernel';

/**
 * Service del módulo hello-world. En un módulo real aquí vivirían
 * los services de dominio (CoursesService, LearningService, etc.).
 */
export class HelloWorldService {
  constructor(private readonly ctx: ModuleContext) {}

  async greet(tenantId: string, name: string): Promise<string> {
    const message = this.ctx.i18n.t('hello-world.greeting', { name });

    await this.ctx.eventBus.publish({
      name: 'hello-world.greeting.requested',
      version: 1,
      data: { name },
      metadata: {
        tenantId,
        timestamp: new Date().toISOString(),
        traceId: `hello-${Date.now()}`,
        idempotencyKey: `hello-${tenantId}-${name}`,
      },
    });

    return message;
  }
}
