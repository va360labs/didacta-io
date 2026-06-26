import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { AccessGroupsService } from './access-groups.service';

interface CoursePublishedPayload {
  courseId: string;
}

/**
 * Puente entre mod.courses y mod.access-groups. Al publicarse un curso
 * (`courses.course.published`), matricula en él a los miembros de los grupos
 * ALL_COURSES con `autoGrantNewCourses` (corrige el gap de Fase 1, donde un
 * curso publicado tras la aprobación nunca se otorgaba retroactivamente).
 *
 * No cruza FKs entre tablas de módulos: solo IDs lógicos vía AccessGroupsService.
 */
@Injectable()
export class AccessGroupsCoursesBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly accessGroups: AccessGroupsService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<CoursePublishedPayload>(
      'courses.course.published',
      async (event: DomainEvent<CoursePublishedPayload>) => {
        const tenantId = event.metadata.tenantId;
        const { courseId } = event.data;
        try {
          await this.accessGroups.onCoursePublished(tenantId, courseId);
        } catch (err) {
          this.logger.error(
            { tenantId, courseId, error: (err as Error).message },
            'AccessGroupsCoursesBridge: fallo al otorgar el curso publicado a grupos ALL_COURSES',
          );
        }
      },
    );
    this.logger.log({}, 'AccessGroupsCoursesBridge: subscribed to courses.course.published');
  }
}
