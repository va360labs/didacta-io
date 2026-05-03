import type { LearndashClient } from '../connector/index.js';
import type { PreflightResultDto } from '../dto.js';

export interface PreflightDeps {
  client: LearndashClient;
}

/**
 * Verifica conectividad al origen, descubre qué APIs están disponibles
 * y devuelve conteos por entidad para que el wizard los muestre antes
 * de ejecutar.
 */
export async function runPreflight(deps: PreflightDeps, signal?: AbortSignal): Promise<PreflightResultDto> {
  const { client } = deps;
  const warnings: PreflightResultDto['warnings'] = [];

  const health = await client.healthcheck();
  if (!health.ok) {
    return {
      ok: false,
      latencyMs: health.latencyMs,
      counts: { courses: 0, lessons: 0, topics: 0, quizzes: 0, groups: 0, users: 0, media: 0 },
      warnings: [],
      capabilities: { learndashV1: false, learndashV2: false, wpRest: false },
      error: { code: 'SOURCE_UNREACHABLE', message: health.error ?? 'origen no responde' },
    };
  }

  const [courses, lessons, topics, quizzes, groups, users, media] = await Promise.all([
    client.countCourses(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_COURSES_FAILED', e.message)),
    client.countLessons(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_LESSONS_FAILED', e.message)),
    client.countTopics(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_TOPICS_FAILED', e.message)),
    client.countQuizzes(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_QUIZZES_FAILED', e.message)),
    client.countGroups(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_GROUPS_FAILED', e.message)),
    client.countUsers(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_USERS_FAILED', e.message)),
    client.countMedia(signal).catch((e: Error) => trackWarn(warnings, 'COUNT_MEDIA_FAILED', e.message)),
  ]);

  return {
    ok: true,
    siteName: health.siteName,
    latencyMs: health.latencyMs,
    counts: {
      courses: typeof courses === 'number' ? courses : 0,
      lessons: typeof lessons === 'number' ? lessons : 0,
      topics: typeof topics === 'number' ? topics : 0,
      quizzes: typeof quizzes === 'number' ? quizzes : 0,
      groups: typeof groups === 'number' ? groups : 0,
      users: typeof users === 'number' ? users : 0,
      media: typeof media === 'number' ? media : 0,
    },
    warnings,
    capabilities: { learndashV1: true, learndashV2: false, wpRest: true },
  };
}

function trackWarn(warnings: PreflightResultDto['warnings'], code: string, message: string): 0 {
  warnings.push({ code, message });
  return 0;
}
