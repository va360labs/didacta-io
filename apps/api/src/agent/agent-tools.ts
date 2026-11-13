/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import type { AgentScope } from './agent-scopes';

/**
 * Catálogo de herramientas del servidor MCP del aula.
 *
 * Cada herramienta declara:
 *   - `scope`: el que tiene que llevar la clave para VERLA en `tools/list` y
 *     para usarla. Un agente nunca ve algo que luego se le va a negar.
 *   - `module`: el módulo del aula del que depende. Si el aula lo tiene
 *     apagado, la herramienta tampoco aparece.
 *   - `input`: el esquema zod con el que se valida SIEMPRE la llamada (el
 *     JSON-RPC llega sin pasar por ningún `ZodValidationPipe`).
 *   - `inputSchema`: el mismo contrato en JSON Schema, que es lo que lee el
 *     agente. `agent-tools.test.ts` comprueba que los dos dicen lo mismo.
 *
 * Las descripciones van en inglés a propósito: las lee un modelo, no una
 * persona, y es el idioma en el que mejor siguen instrucciones todos los
 * agentes a los que se apunta (Claude, Codex, Grok, Hermes…). Lo que el agente
 * CREA sí va en el idioma que le pida el creador.
 */

const uuid = z.string().uuid();
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => u.toLowerCase().startsWith('https://'), {
    message: 'The link must start with https://',
  });

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const listCoursesInput = z
  .object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() })
  .strict();

export const getCourseInput = z.object({ courseId: uuid }).strict();

export const createCourseInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateCourseInput = z
  .object({
    courseId: uuid,
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'Send at least one of: title, description',
  });

export const createLessonInput = z
  .object({
    courseId: uuid,
    title: z.string().trim().min(1).max(160),
    type: z.enum(['text', 'video']),
    text: z.string().max(100_000).optional(),
    videoUrl: httpsUrl.optional(),
  })
  .strict()
  .refine((v) => v.type === 'video' || v.videoUrl === undefined, {
    message: 'videoUrl only applies to type "video"',
  })
  .refine((v) => v.type === 'text' || v.text === undefined, {
    message: 'text only applies to type "text"',
  });

export const updateLessonInput = z
  .object({
    lessonId: uuid,
    title: z.string().trim().min(1).max(160).optional(),
    text: z.string().max(100_000).optional(),
    videoUrl: httpsUrl.optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.text !== undefined || v.videoUrl !== undefined, {
    message: 'Send at least one of: title, text, videoUrl',
  });

export const listLiveClassesInput = z.object({}).strict();

export const scheduleLiveClassInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    startTime: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(15).max(480),
    timezone: z.string().trim().min(3).max(64).refine(isTimeZone, {
      message: 'Unknown IANA time zone (e.g. Europe/Madrid)',
    }),
    joinUrl: httpsUrl,
    description: z.string().trim().max(2000).optional(),
    courseId: uuid.optional(),
    announce: z.boolean().optional(),
  })
  .strict();

export const listCommunitySpacesInput = z.object({}).strict();

export const createCommunityPostInput = z
  .object({
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(1).max(10_000),
    space: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,59}$/)
      .optional(),
  })
  .strict();

export type AgentToolName =
  | 'list_courses'
  | 'get_course'
  | 'create_course'
  | 'update_course'
  | 'create_lesson'
  | 'update_lesson'
  | 'list_live_classes'
  | 'schedule_live_class'
  | 'list_community_spaces'
  | 'create_community_post';

export interface AgentTool {
  name: AgentToolName;
  title: string;
  description: string;
  scope: AgentScope;
  /** Módulo del aula del que depende (nombre del manifest). */
  module: string;
  /** Escribe en el aula: cuenta en el límite de escrituras y deja rastro en auditoría. */
  writes: boolean;
  input: z.ZodTypeAny;
  inputSchema: Record<string, unknown>;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const DRAFT_NOTE =
  'Everything you create stays as a DRAFT: the academy owner reviews it and publishes it (with its price) from "Start here". You cannot publish, set prices, delete anything or invite people.';

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: 'list_courses',
    title: 'List courses',
    description:
      'List the courses of this academy with their id, title, status (DRAFT, PUBLISHED, ARCHIVED) and number of lessons. Use it first to find the courseId of an existing course.',
    scope: 'agent:courses:read',
    module: 'mod.courses',
    writes: false,
    input: listCoursesInput,
    inputSchema: obj({
      status: {
        type: 'string',
        enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
        description: 'Only courses in this status.',
      },
    }),
  },
  {
    name: 'get_course',
    title: 'Get a course',
    description:
      'Get one course with its lessons in order (id, title, type and whether each lesson already has content).',
    scope: 'agent:courses:read',
    module: 'mod.courses',
    writes: false,
    input: getCourseInput,
    inputSchema: obj({ courseId: { type: 'string', format: 'uuid' } }, ['courseId']),
  },
  {
    name: 'create_course',
    title: 'Create a course',
    description: `Create a new course with a title and an optional short description (plain text). Its web address is generated from the title. ${DRAFT_NOTE}`,
    scope: 'agent:courses:write',
    module: 'mod.courses',
    writes: true,
    input: createCourseInput,
    inputSchema: obj(
      {
        title: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 2000 },
      },
      ['title'],
    ),
  },
  {
    name: 'update_course',
    title: 'Rename or describe a course',
    description:
      'Change the title and/or the description of an existing course. It does not change its status or its price.',
    scope: 'agent:courses:write',
    module: 'mod.courses',
    writes: true,
    input: updateCourseInput,
    inputSchema: obj(
      {
        courseId: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 2000 },
      },
      ['courseId'],
    ),
  },
  {
    name: 'create_lesson',
    title: 'Add a lesson',
    description:
      'Add a lesson at the end of a course. type "text": `text` is shown to students as plain text (line breaks are kept; HTML and Markdown are NOT rendered). type "video": `videoUrl` is an https link to a video (YouTube, Vimeo, Bunny…). Call it once per lesson, in order. Do not number the titles: the academy numbers the lessons by itself.',
    scope: 'agent:courses:write',
    module: 'mod.courses',
    writes: true,
    input: createLessonInput,
    inputSchema: obj(
      {
        courseId: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        type: { type: 'string', enum: ['text', 'video'] },
        text: { type: 'string', maxLength: 100000, description: 'Only for type "text".' },
        videoUrl: {
          type: 'string',
          format: 'uri',
          description: 'Only for type "video". Must start with https://',
        },
      },
      ['courseId', 'title', 'type'],
    ),
  },
  {
    name: 'update_lesson',
    title: 'Edit a lesson',
    description:
      'Change the title, the text (text lessons) or the video link (video lessons) of an existing lesson. The lesson type cannot change.',
    scope: 'agent:courses:write',
    module: 'mod.courses',
    writes: true,
    input: updateLessonInput,
    inputSchema: obj(
      {
        lessonId: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        text: { type: 'string', maxLength: 100000 },
        videoUrl: { type: 'string', format: 'uri' },
      },
      ['lessonId'],
    ),
  },
  {
    name: 'list_live_classes',
    title: 'List upcoming live classes',
    description: 'List the upcoming live classes of the academy (title, start time, duration).',
    scope: 'agent:live:write',
    module: 'mod.zoom-live',
    writes: false,
    input: listLiveClassesInput,
    inputSchema: obj({}),
  },
  {
    name: 'schedule_live_class',
    title: 'Schedule a live class',
    description:
      'Schedule a live class that students join with the video-call link the owner already uses (Zoom, Google Meet, Teams, Jitsi…). startTime is ISO 8601 WITH offset (e.g. 2026-11-20T19:00:00+01:00) and timezone is an IANA name (e.g. Europe/Madrid). With announce=true it is also announced in the community.',
    scope: 'agent:live:write',
    module: 'mod.zoom-live',
    writes: true,
    input: scheduleLiveClassInput,
    inputSchema: obj(
      {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        startTime: { type: 'string', format: 'date-time' },
        durationMinutes: { type: 'integer', minimum: 15, maximum: 480 },
        timezone: { type: 'string', description: 'IANA time zone, e.g. Europe/Madrid' },
        joinUrl: { type: 'string', format: 'uri', description: 'https link of the video call' },
        description: { type: 'string', maxLength: 2000 },
        courseId: { type: 'string', format: 'uuid', description: 'Optional: link it to a course.' },
        announce: { type: 'boolean', description: 'Also announce it in the community.' },
      },
      ['title', 'startTime', 'durationMinutes', 'timezone', 'joinUrl'],
    ),
  },
  {
    name: 'list_community_spaces',
    title: 'List community spaces',
    description: 'List the spaces of the community (slug and title) to choose where to post.',
    scope: 'agent:community:post',
    module: 'mod.community',
    writes: false,
    input: listCommunitySpacesInput,
    inputSchema: obj({}),
  },
  {
    name: 'create_community_post',
    title: 'Post in the community',
    description:
      'Publish a post in the community, signed by the academy owner. `space` is the slug of a space (see list_community_spaces); without it the post goes to "general". It does not email the members.',
    scope: 'agent:community:post',
    module: 'mod.community',
    writes: true,
    input: createCommunityPostInput,
    inputSchema: obj(
      {
        title: { type: 'string', minLength: 3, maxLength: 200 },
        body: { type: 'string', minLength: 1, maxLength: 10000 },
        space: { type: 'string', description: 'Space slug, e.g. general' },
      },
      ['title', 'body'],
    ),
  },
];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}
