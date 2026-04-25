import type { LearnShipModule, ModuleContext } from '@learnship/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export { CoursesService } from './courses.service.js';
export {
  createCourseSchema,
  updateCourseSchema,
  createModuleSchema,
  createLessonSchema,
  updateLessonSchema,
  type CreateCourseDto,
  type UpdateCourseDto,
  type CreateModuleDto,
  type CreateLessonDto,
  type UpdateLessonDto,
} from './dto.js';
export {
  CoursesError,
  CourseNotFoundError,
  CourseSlugAlreadyExistsError,
  CourseAlreadyPublishedError,
  CourseHasNoLessonsError,
  PublishValidationError,
} from './errors.js';

export const coursesModule: LearnShipModule = {
  manifest,

  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.courses: onRegister', { name: manifest.name });
  },

  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.courses: onEnable', { tenantId });
  },

  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.courses: onDisable', { tenantId });
  },

  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.courses: onUninstall', { tenantId });
  },
};
