import type { LearndashClient } from '../connector/index.js';
import type { JobsPort, StagingPort, AuditPort, Logger } from './ports.js';
import { computeChecksum } from './checksum.js';
import type { ProgressBus } from './progress.js';
import { nowIso } from './progress.js';

export interface ExtractorDeps {
  client: LearndashClient;
  jobs: JobsPort;
  staging: StagingPort;
  audit: AuditPort;
  bus: ProgressBus;
  logger: Logger;
}

export interface ExtractScope {
  users: boolean;
  media: boolean;
  courses: boolean;
  groups: boolean;
  quizzes: boolean;
  enrollments: boolean;
  progress: boolean;
}

/**
 * Fase EXTRACT: lee del origen y rellena las tablas stg_*.
 * Idempotente por checksum — si la fila ya existe con mismo checksum,
 * se sobrescribe el rawPayload (no causa cambio, pero es seguro).
 */
export async function runExtract(
  deps: ExtractorDeps,
  jobId: string,
  tenantId: string,
  scope: ExtractScope,
  signal?: AbortSignal,
): Promise<void> {
  const { client, jobs, staging, audit, bus, logger } = deps;

  const checkCancelled = async (): Promise<boolean> => {
    if (signal?.aborted) return true;
    return jobs.isCancelling(jobId);
  };

  await jobs.updateStatus(jobId, 'extracting', 'extract:start');
  await audit.append(tenantId, jobId, 'system', 'phase.started', null, null, { phase: 'extract' });
  bus.emit(jobId, { type: 'phase.started', phase: 'extract', at: nowIso() });

  // 1. Users
  if (scope.users) {
    let count = 0;
    for await (const batch of client.iterUsers(signal)) {
      if (await checkCancelled()) return;
      for (const u of batch.items) {
        const checksum = computeChecksum(u);
        await staging.upsertUser(tenantId, jobId, String(u.id), u, checksum);
        count += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:users', current: count, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.users.done', { jobId, count });
  }

  // 2. Media
  if (scope.media) {
    let count = 0;
    for await (const batch of client.iterMedia(signal)) {
      if (await checkCancelled()) return;
      for (const m of batch.items) {
        if (!m.source_url) continue;
        const checksum = computeChecksum(m);
        await staging.upsertMedia(tenantId, jobId, String(m.id), m.source_url, m, checksum);
        count += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:media', current: count, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.media.done', { jobId, count });
  }

  // Maps (lesson|topic|quiz → courseId) construidos con `/sfwd-courses/:id/steps`.
  // LearnDash REST v1 NO incluye el campo `course` en la respuesta plana de
  // `/sfwd-lessons` ni `/sfwd-topic` — los parents solo se obtienen por el
  // árbol del curso. Sin este mapping, el transformer marca todas las
  // lessons/topics como MISSING_DEPENDENCY y la migración queda estructuralmente
  // vacía (cursos sin contenido). Se poblan en el bloque scope.courses; las
  // referencias en lessons/topics/quizzes los consumen con el operador `.get()`
  // que retorna `undefined` si el bloque no corrió (e.g. scope sin courses).
  const lessonToCourse = new Map<number, number>();
  const topicToCourse = new Map<number, number>();
  const topicToLesson = new Map<number, number>();
  const quizToCourse = new Map<number, number>();

  // 3. Cursos
  if (scope.courses) {
    let count = 0;
    const courseIds: number[] = [];
    for await (const batch of client.iterCourses(signal)) {
      if (await checkCancelled()) return;
      for (const c of batch.items) {
        const checksum = computeChecksum(c);
        await staging.upsertCourse(tenantId, jobId, String(c.id), c, checksum);
        courseIds.push(c.id);
        count += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:courses', current: count, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.courses.done', { jobId, count });

    // 3b. Populamos los maps llamando `/sfwd-courses/:id/steps` por cada curso.
    for (const courseId of courseIds) {
      if (await checkCancelled()) return;
      try {
        const steps = await client.getCourseSteps(courseId, signal);
        for (const step of steps) {
          if (step.type === 'sfwd-lessons') {
            lessonToCourse.set(step.id, courseId);
          } else if (step.type === 'sfwd-topic') {
            topicToCourse.set(step.id, courseId);
            // step.parent del topic = lessonId (si cuelga de una lesson).
            // Si parent == courseId, el topic cuelga directo del curso.
            if (step.parent && step.parent !== courseId) {
              topicToLesson.set(step.id, step.parent);
            }
          } else if (step.type === 'sfwd-quiz') {
            quizToCourse.set(step.id, courseId);
          }
        }
      } catch (err) {
        // Si el endpoint /steps falla para un curso, lo logueamos y
        // seguimos: las lessons/topics de ese curso quedarán huérfanas
        // y se rebotarán en transform — preferible a abortar todo el job.
        logger.info('extract.course.steps.failed', {
          jobId,
          courseId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('extract.course.steps.done', {
      jobId,
      lessonsMapped: lessonToCourse.size,
      topicsMapped: topicToCourse.size,
      quizzesMapped: quizToCourse.size,
    });

    // 4. Lessons
    let lessonCount = 0;
    for await (const batch of client.iterLessons(signal)) {
      if (await checkCancelled()) return;
      let idx = 0;
      for (const l of batch.items) {
        const checksum = computeChecksum(l);
        const stepCourseId = lessonToCourse.get(l.id);
        const parentCourseId = l.course
          ? String(l.course)
          : stepCourseId !== undefined
            ? String(stepCourseId)
            : null;
        await staging.upsertLesson(tenantId, jobId, String(l.id), parentCourseId, idx++, l, checksum);
        lessonCount += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:lessons', current: lessonCount, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.lessons.done', { jobId, count: lessonCount });

    // 5. Topics
    let topicCount = 0;
    for await (const batch of client.iterTopics(signal)) {
      if (await checkCancelled()) return;
      let idx = 0;
      for (const t of batch.items) {
        const checksum = computeChecksum(t);
        const stepCourseId = topicToCourse.get(t.id);
        const stepLessonId = topicToLesson.get(t.id);
        const parentCourseId = t.course
          ? String(t.course)
          : stepCourseId !== undefined
            ? String(stepCourseId)
            : null;
        const parentLessonId = t.lesson
          ? String(t.lesson)
          : stepLessonId !== undefined
            ? String(stepLessonId)
            : null;
        await staging.upsertTopic(
          tenantId,
          jobId,
          String(t.id),
          parentLessonId,
          parentCourseId,
          idx++,
          t,
          checksum,
        );
        topicCount += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:topics', current: topicCount, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.topics.done', { jobId, count: topicCount });
  }

  // 6. Quizzes y questions
  if (scope.quizzes) {
    let quizCount = 0;
    const quizIds: number[] = [];
    for await (const batch of client.iterQuizzes(signal)) {
      if (await checkCancelled()) return;
      for (const q of batch.items) {
        const checksum = computeChecksum(q);
        const stepCourseId = quizToCourse.get(q.id);
        await staging.upsertQuiz(
          tenantId,
          jobId,
          String(q.id),
          {
            courseId: q.course
              ? String(q.course)
              : stepCourseId !== undefined
                ? String(stepCourseId)
                : undefined,
            lessonId: q.lesson ? String(q.lesson) : undefined,
            topicId: q.topic ? String(q.topic) : undefined,
          },
          q,
          checksum,
        );
        quizIds.push(q.id);
        quizCount += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:quizzes', current: quizCount, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.quizzes.done', { jobId, count: quizCount });

    let questionCount = 0;
    for (const quizId of quizIds) {
      if (await checkCancelled()) return;
      try {
        const questions = await client.iterQuizQuestions(quizId, signal);
        for (const q of questions) {
          const checksum = computeChecksum(q);
          await staging.upsertQuestion(
            tenantId,
            jobId,
            String(q.id),
            String(quizId),
            q.question_type ?? 'single',
            q,
            checksum,
          );
          questionCount += 1;
        }
        bus.emit(jobId, { type: 'phase.progress', phase: 'extract:questions', current: questionCount, at: nowIso() });
      } catch (err) {
        logger.warn('extract.questions.quiz_failed', { jobId, quizId, error: (err as Error).message });
      }
    }
    logger.info('extract.questions.done', { jobId, count: questionCount });
  }

  // 7. Groups
  if (scope.groups) {
    let count = 0;
    for await (const batch of client.iterGroups(signal)) {
      if (await checkCancelled()) return;
      for (const g of batch.items) {
        const checksum = computeChecksum(g);
        await staging.upsertGroup(tenantId, jobId, String(g.id), g, checksum);
        count += 1;
      }
      bus.emit(jobId, { type: 'phase.progress', phase: 'extract:groups', current: count, total: batch.total, at: nowIso() });
      if (batch.done) break;
    }
    logger.info('extract.groups.done', { jobId, count });
  }

  // 8. Enrollments + progress: la API ldlms/v1 no tiene un endpoint masivo;
  // hay que iterar por curso + por grupo. En MVP omitimos progress detallado
  // y nos quedamos con enrollments.
  if (scope.enrollments) {
    // Para no doblar latencia, reusamos lo que ya está en staging
    const courses = await staging.listAll('courses', tenantId, jobId, 100_000);
    let enrollCount = 0;
    for (const c of courses) {
      if (await checkCancelled()) return;
      try {
        const users = await client.getCourseUsers(Number(c.sourceId), signal);
        for (const u of users) {
          const checksum = computeChecksum({ courseId: c.sourceId, userId: u.id });
          await staging.upsertEnrollment(
            tenantId,
            jobId,
            { sourceUserId: String(u.id), sourceCourseId: c.sourceId, sourceGroupId: null, enrollmentKind: 'direct' },
            u,
            checksum,
          );
          enrollCount += 1;
        }
      } catch (err) {
        logger.warn('extract.enrollments.course_failed', { jobId, courseId: c.sourceId, error: (err as Error).message });
      }
    }

    if (scope.groups) {
      const groups = await staging.listAll('groups', tenantId, jobId, 100_000);
      for (const g of groups) {
        if (await checkCancelled()) return;
        try {
          const users = await client.getGroupUsers(Number(g.sourceId), signal);
          for (const u of users) {
            const checksum = computeChecksum({ groupId: g.sourceId, userId: u.id });
            await staging.upsertEnrollment(
              tenantId,
              jobId,
              { sourceUserId: String(u.id), sourceCourseId: null, sourceGroupId: g.sourceId, enrollmentKind: 'group' },
              u,
              checksum,
            );
            enrollCount += 1;
          }
        } catch (err) {
          logger.warn('extract.enrollments.group_failed', { jobId, groupId: g.sourceId, error: (err as Error).message });
        }
      }
    }

    bus.emit(jobId, { type: 'phase.progress', phase: 'extract:enrollments', current: enrollCount, at: nowIso() });
    logger.info('extract.enrollments.done', { jobId, count: enrollCount });
  }

  await audit.append(tenantId, jobId, 'system', 'phase.completed', null, null, { phase: 'extract' });
  bus.emit(jobId, { type: 'phase.completed', phase: 'extract', counts: {}, at: nowIso() });
}
