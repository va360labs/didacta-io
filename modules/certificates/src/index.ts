import type { LearnShipModule, ModuleContext, DomainEvent } from '@learnship/core-kernel';
import { manifest } from './manifest.js';
import { CertificatesService } from './certificates.service.js';

export { manifest };
export { CertificatesService };
export { renderCertificatePdf } from './pdf-renderer.js';
export {
  CertificatesError,
  CertificateNotFoundError,
  CertificateAlreadyIssuedError,
} from './errors.js';

interface CourseCompletedPayload {
  enrollmentId: string;
  courseId: string;
  userId: string;
}

/**
 * Factory que devuelve el módulo cableado con el service.
 * El handler de `learning.course.completed` necesita el service para emitir.
 * Por eso el módulo se construye dinámicamente con la instancia del service.
 */
export function buildCertificatesModule(service: CertificatesService): LearnShipModule {
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.certificates: onRegister', { name: manifest.name });

      // Suscripción al evento de finalización de curso → emite certificado automáticamente.
      ctx.eventBus.subscribe<CourseCompletedPayload>(
        'learning.course.completed',
        async (event: DomainEvent<CourseCompletedPayload>) => {
          try {
            await service.issueCertificateForEnrollment({
              tenantId: event.metadata.tenantId,
              enrollmentId: event.data.enrollmentId,
              userId: event.data.userId,
              courseId: event.data.courseId,
            });
            ctx.logger.info('mod.certificates: emitido tras course.completed', {
              enrollmentId: event.data.enrollmentId,
            });
          } catch (error) {
            ctx.logger.error('mod.certificates: fallo emisión automática', {
              enrollmentId: event.data.enrollmentId,
              error: (error as Error).message,
            });
          }
        },
      );
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.certificates: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.certificates: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.certificates: onUninstall', { tenantId });
    },
  };
}
