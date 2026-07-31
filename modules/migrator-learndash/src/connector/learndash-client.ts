/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { MinimalLogger } from './client.js';
import { RestConnector } from './client.js';
import type { AuthStrategy } from './auth.js';
import { paginate, type Batch } from './pagination.js';

/**
 * Tipos parciales de LearnDash REST v1 / WordPress REST.
 * Solo declaramos los campos que el migrador realmente consume.
 * Cualquier campo extra del origen viaja en `rawPayload` sin tipar.
 */

export interface LdCourse {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  status?: string;
  date_gmt?: string;
  modified_gmt?: string;
  featured_media?: number;
  meta?: Record<string, unknown>;
  // Campos LearnDash-específicos:
  materials_enabled?: boolean;
  materials?: string;
  certificate?: number;
  price_type?: string;
  price?: string;
  prerequisite_enabled?: boolean;
  prerequisite_compare?: 'ANY' | 'ALL';
  prerequisites?: number[];
  points_enabled?: boolean;
  points?: number;
  expire_access?: boolean;
  expire_access_days?: number;
}

export interface LdLesson {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  content?: { rendered: string; protected?: boolean } | string;
  status?: string;
  course?: number;
  // pasos hijos
  meta?: Record<string, unknown>;
  forced_timer_enabled?: boolean;
  forced_timer?: number;
  assignment_upload_enabled?: boolean;
  assignment_upload_limit_extensions?: string;
  assignment_upload_limit_size?: string;
  assignment_points_enabled?: boolean;
  assignment_points_amount?: number;
  visible_after?: number;
  visible_after_specific_date?: string;
}

export interface LdTopic {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  status?: string;
  course?: number;
  lesson?: number;
  meta?: Record<string, unknown>;
}

export interface LdQuiz {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  status?: string;
  course?: number;
  lesson?: number;
  topic?: number;
  meta?: Record<string, unknown>;
  passingpercentage?: number;
  threshold?: number;
  certificate?: number;
}

export interface LdQuestion {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  status?: string;
  quiz?: number;
  meta?: Record<string, unknown>;
  question_type?: string;
  points?: number;
  // _answerData en LearnDash es un campo serializado; lo tomamos como unknown
  // y el mapper se encarga de normalizar.
  answerData?: unknown;
  _answerData?: unknown;
}

export interface LdGroup {
  id: number;
  slug: string;
  title?: { rendered: string } | string;
  status?: string;
}

export interface LdCourseStep {
  id: number;
  type: 'sfwd-lessons' | 'sfwd-topic' | 'sfwd-quiz';
  parent: number;
  order: number;
}

export interface WpUser {
  id: number;
  username?: string;
  name?: string;
  email?: string;
  url?: string;
  description?: string;
  registered_date?: string;
  roles?: string[];
  meta?: Record<string, unknown>;
}

export interface WpMedia {
  id: number;
  date_gmt?: string;
  slug?: string;
  link?: string;
  title?: { rendered: string };
  source_url?: string;
  mime_type?: string;
  media_details?: { width?: number; height?: number; filesize?: number };
}

/**
 * Cliente tipado para LearnDash + WordPress REST.
 *
 * NOTA: la documentación de v2 (ldlms/v2) existe pero está incompleta en
 * páginas públicas; usamos v1 que está verificada. Si una instancia tiene
 * v2 disponible, se puede ampliar el cliente.
 */
export class LearndashClient {
  private readonly connector: RestConnector;

  constructor(opts: {
    baseUrl: string;
    auth: AuthStrategy;
    logger: MinimalLogger;
    rateLimit?: { rps: number };
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.connector = new RestConnector({
      baseUrl: opts.baseUrl,
      auth: opts.auth,
      logger: opts.logger,
      rateLimit: opts.rateLimit ?? { rps: 5 },
      timeoutMs: opts.timeoutMs ?? 30_000,
      userAgent: 'Didacta/migrator-learndash 1.0',
      fetchImpl: opts.fetchImpl,
    });
  }

  // ---- Healthcheck ----

  async healthcheck(): Promise<{
    ok: boolean;
    latencyMs: number;
    siteName?: string;
    error?: string;
  }> {
    const result = await this.connector.healthcheck();
    if (!result.ok) return { ok: false, latencyMs: result.latencyMs, error: result.error };
    const info = result.serverInfo as { name?: string; description?: string } | undefined;
    return { ok: true, latencyMs: result.latencyMs, siteName: info?.name };
  }

  // ---- Conteos preflight (cabeza per_page=1 para leer X-WP-Total) ----

  async countCourses(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/ldlms/v1/sfwd-courses', signal);
  }
  async countLessons(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/ldlms/v1/sfwd-lessons', signal);
  }
  async countTopics(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/ldlms/v1/sfwd-topic', signal);
  }
  async countQuizzes(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/ldlms/v1/sfwd-quiz', signal);
  }
  async countGroups(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/ldlms/v1/groups', signal);
  }
  async countUsers(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/wp/v2/users', signal, { context: 'edit' });
  }
  async countMedia(signal?: AbortSignal): Promise<number> {
    return this.countOf('/wp-json/wp/v2/media', signal);
  }

  private async countOf(
    path: string,
    signal?: AbortSignal,
    extraQuery?: Record<string, string | number>,
  ): Promise<number> {
    const response = await this.connector.requestRaw<unknown[]>('GET', path, {
      query: { per_page: 1, page: 1, ...extraQuery },
      signal,
    });
    const total = response.headers.get('X-WP-Total');
    if (total === null) return Array.isArray(response.body) ? response.body.length : 0;
    const parsed = Number(total);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // ---- Iteradores paginados ----

  iterCourses(signal?: AbortSignal): AsyncIterableIterator<Batch<LdCourse>> {
    return paginate<LdCourse>(this.connector, '/wp-json/ldlms/v1/sfwd-courses', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  iterLessons(signal?: AbortSignal): AsyncIterableIterator<Batch<LdLesson>> {
    return paginate<LdLesson>(this.connector, '/wp-json/ldlms/v1/sfwd-lessons', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  iterTopics(signal?: AbortSignal): AsyncIterableIterator<Batch<LdTopic>> {
    return paginate<LdTopic>(this.connector, '/wp-json/ldlms/v1/sfwd-topic', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  iterQuizzes(signal?: AbortSignal): AsyncIterableIterator<Batch<LdQuiz>> {
    return paginate<LdQuiz>(this.connector, '/wp-json/ldlms/v1/sfwd-quiz', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  iterGroups(signal?: AbortSignal): AsyncIterableIterator<Batch<LdGroup>> {
    return paginate<LdGroup>(this.connector, '/wp-json/ldlms/v1/groups', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  iterUsers(signal?: AbortSignal): AsyncIterableIterator<Batch<WpUser>> {
    return paginate<WpUser>(this.connector, '/wp-json/wp/v2/users', {
      strategy: 'page-number',
      perPage: 100,
      query: { context: 'edit' },
      signal,
    });
  }

  iterMedia(signal?: AbortSignal): AsyncIterableIterator<Batch<WpMedia>> {
    return paginate<WpMedia>(this.connector, '/wp-json/wp/v2/media', {
      strategy: 'page-number',
      perPage: 100,
      signal,
    });
  }

  // ---- Recursos individuales ----

  async getCourseSteps(courseId: number, signal?: AbortSignal): Promise<LdCourseStep[]> {
    return (await this.connector.request<LdCourseStep[]>(
      'GET',
      `/wp-json/ldlms/v1/sfwd-courses/${courseId}/steps`,
      { signal },
    )) as LdCourseStep[];
  }

  async getCourseUsers(courseId: number, signal?: AbortSignal): Promise<WpUser[]> {
    const items: WpUser[] = [];
    for await (const batch of paginate<WpUser>(
      this.connector,
      `/wp-json/ldlms/v1/sfwd-courses/${courseId}/users`,
      { strategy: 'page-number', perPage: 100, signal },
    )) {
      items.push(...batch.items);
      if (batch.done) break;
    }
    return items;
  }

  async getGroupUsers(groupId: number, signal?: AbortSignal): Promise<WpUser[]> {
    const items: WpUser[] = [];
    for await (const batch of paginate<WpUser>(
      this.connector,
      `/wp-json/ldlms/v1/groups/${groupId}/users`,
      { strategy: 'page-number', perPage: 100, signal },
    )) {
      items.push(...batch.items);
      if (batch.done) break;
    }
    return items;
  }

  async iterQuizQuestions(quizId: number, signal?: AbortSignal): Promise<LdQuestion[]> {
    const items: LdQuestion[] = [];
    for await (const batch of paginate<LdQuestion>(
      this.connector,
      `/wp-json/ldlms/v1/sfwd-quiz/${quizId}/questions`,
      { strategy: 'page-number', perPage: 100, signal },
    )) {
      items.push(...batch.items);
      if (batch.done) break;
    }
    return items;
  }
}
