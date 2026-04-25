export class CoursesError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoursesError';
  }
}

export class CourseNotFoundError extends CoursesError {
  constructor(courseId: string) {
    super('COURSE_NOT_FOUND', `Curso no encontrado: ${courseId}`);
  }
}

export class CourseSlugAlreadyExistsError extends CoursesError {
  constructor(slug: string) {
    super('COURSE_SLUG_EXISTS', `Ya existe un curso con slug "${slug}" en este tenant`);
  }
}

export class CourseAlreadyPublishedError extends CoursesError {
  constructor(courseId: string) {
    super('COURSE_ALREADY_PUBLISHED', `El curso ${courseId} ya está publicado`);
  }
}

export class CourseHasNoLessonsError extends CoursesError {
  constructor() {
    super('COURSE_NO_LESSONS', 'No se puede publicar un curso sin al menos una lección');
  }
}

export class PublishValidationError extends CoursesError {
  constructor(public readonly reasons: readonly string[]) {
    super(
      'COURSE_PUBLISH_VALIDATION_FAILED',
      `Validación de publicación falló: ${reasons.join('; ')}`,
    );
  }
}
