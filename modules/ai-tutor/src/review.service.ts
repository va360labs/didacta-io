/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  clusterQuestions,
  formatVector,
  parseVector,
  type ClusterableQuestion,
} from './clustering.js';
import type {
  CorrectionView,
  ListAnswersDto,
  ListAnswersResultView,
  MonthlyReportDto,
  MonthlyReportView,
  ReportTopicView,
  ReviewAnswerDto,
  ReviewAnswerView,
  ReviewStatus,
  UpsertCorrectionDto,
} from './dto.js';
import {
  CorrectionNotFoundError,
  EmbeddingsProviderError,
  MessageNotFoundError,
} from './errors.js';

/**
 * Revisión humana del tutor IA y realimentación del conocimiento (bloque de
 * calidad del tutor).
 *
 * Tres cosas, en este orden de importancia:
 *
 *   1. **Ver qué se pregunta y qué se contesta.** `listAnswers` devuelve pares
 *      pregunta→respuesta con quién preguntó, en qué curso y en qué se apoyó el
 *      tutor. El filtro que más vale es `soloSinCitas`: una respuesta sin
 *      ninguna cita al material es la que más probablemente esté mal.
 *
 *   2. **Corregir.** `review` marca la respuesta como OK o CORRECTED. Corregir
 *      obliga a escribir la respuesta buena, y esa respuesta se guarda en
 *      `mod_ai_tutor_correction` con su embedding. A partir de ahí el chat la
 *      recupera por similitud y la mete en el prompt con prioridad sobre el
 *      material del curso: el tutor deja de equivocarse en esa pregunta sin
 *      tocar ni una lección.
 *
 *      La corrección NO se guarda como chunk a propósito. Reindexar un curso
 *      hace DELETE + INSERT de todos sus chunks; una corrección guardada ahí
 *      duraría hasta el siguiente `courses.lesson.updated`.
 *
 *   3. **Informe mensual.** `monthlyReport` agrupa por embedding las preguntas
 *      del mes y devuelve los temas ordenados por volumen, con cuántos alumnos
 *      distintos preguntaron y quiénes. Lo que se repite y sale sin respaldo es
 *      exactamente el material que falta por grabar.
 *
 * `embedFn` se inyecta igual que en indexer y chat: el service no se acopla al
 * AI Gateway y los tests no necesitan proveedor.
 */

export interface EmbedFn {
  (args: {
    tenantId: string;
    texts: string[];
  }): Promise<{ embeddings: number[][]; totalTokens: number; dimension: number }>;
}

/**
 * Techo de preguntas que se analizan en un informe. No es una paginación: es
 * una defensa. Cada pregunta arrastra un vector de 1536 floats leído como
 * texto; 1.500 son ~9 MB de transferencia y menos de un segundo de agrupado.
 * Cuando se supera, el informe lo dice (`truncado`) en vez de mentir.
 */
const MAX_PREGUNTAS_INFORME = 1500;

/** Lotes de embeddings al rellenar preguntas antiguas. Igual que el indexer. */
const EMBED_BATCH = 64;

interface AnswerRow {
  id: string;
  conversation_id: string;
  answer: string;
  citations: unknown;
  created_at: Date;
  review_status: string;
  reviewed_by_id: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  question: string | null;
  user_id: string;
  course_id: string;
}

interface QuestionRow {
  id: string;
  question: string;
  embedding: string | null;
  user_id: string;
  course_id: string;
  created_at: Date;
  answer_id: string | null;
  review_status: string | null;
  sin_respaldo: boolean | null;
}

interface CorrectionRow {
  id: string;
  courseId: string | null;
  question: string;
  answer: string;
  active: boolean;
  timesUsed: number;
  authorId: string;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AiTutorReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    private readonly embedFn: EmbedFn,
  ) {}

  // ─── 1. Ver qué se pregunta y qué se contesta ─────────────────────────────

  async listAnswers(tenantId: string, filtros: ListAnswersDto): Promise<ListAnswersResultView> {
    const params: unknown[] = [tenantId];
    // El estado va aparte del resto para poder contar los pendientes con los
    // mismos filtros pero sin el de estado — si no, filtrar por "revisadas"
    // dejaría el contador de pendientes siempre a cero.
    const base: string[] = [`a."tenant_id" = $1::uuid`, `a."role" = 'assistant'`];

    if (filtros.courseId) {
      params.push(filtros.courseId);
      base.push(`conv."course_id" = $${params.length}::uuid`);
    }
    if (filtros.soloSinCitas) {
      base.push(`(a."citations" IS NULL OR a."citations" = '[]'::jsonb)`);
    }
    if (filtros.q) {
      params.push(`%${filtros.q}%`);
      base.push(`(a."content" ILIKE $${params.length} OR q."content" ILIKE $${params.length})`);
    }
    if (filtros.desde) {
      params.push(new Date(filtros.desde));
      base.push(`a."created_at" >= $${params.length}`);
    }
    if (filtros.hasta) {
      params.push(new Date(filtros.hasta));
      base.push(`a."created_at" < $${params.length}`);
    }

    // Foto de los parámetros que `base` referencia, ANTES de añadir el de
    // estado. La query de pendientes usa `base` (sin el placeholder del
    // estado) pero se ejecutaba con `...params`, que sí lo incluía cuando
    // había filtro: Postgres rechaza el Bind con más parámetros de los que el
    // statement declara (08P01) y, como las tres van en un `Promise.all`, el
    // panel entero devolvía 500 en cuanto un admin pulsaba "solo pendientes"
    // o "solo corregidas".
    const paramsBase = [...params];

    const conEstado = [...base];
    if (filtros.status) {
      params.push(filtros.status);
      conEstado.push(`a."review_status" = $${params.length}`);
    }

    const FROM = `
      FROM "mod_ai_tutor_message" a
      JOIN "mod_ai_tutor_conversation" conv ON conv."id" = a."conversation_id"
      LEFT JOIN LATERAL (
        SELECT m."content"
        FROM "mod_ai_tutor_message" m
        WHERE m."conversation_id" = a."conversation_id"
          AND m."role" = 'user'
          AND m."created_at" <= a."created_at"
        ORDER BY m."created_at" DESC
        LIMIT 1
      ) q ON true`;

    const offset = (filtros.page - 1) * filtros.pageSize;
    const paramsPagina = [...params, filtros.pageSize, offset];

    const [rows, totalRows, pendientesRows] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `SELECT
           a."id"::text AS "id",
           a."conversation_id"::text AS "conversation_id",
           a."content" AS "answer",
           a."citations" AS "citations",
           a."created_at" AS "created_at",
           a."review_status" AS "review_status",
           a."reviewed_by_id"::text AS "reviewed_by_id",
           a."reviewed_at" AS "reviewed_at",
           a."review_note" AS "review_note",
           q."content" AS "question",
           conv."user_id"::text AS "user_id",
           conv."course_id"::text AS "course_id"
         ${FROM}
         WHERE ${conEstado.join(' AND ')}
         ORDER BY a."created_at" DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...paramsPagina,
      ) as Promise<AnswerRow[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS "n" ${FROM} WHERE ${conEstado.join(' AND ')}`,
        ...params,
      ) as Promise<Array<{ n: number }>>,
      this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS "n" ${FROM}
         WHERE ${base.join(' AND ')} AND a."review_status" = 'PENDING'`,
        ...paramsBase,
      ) as Promise<Array<{ n: number }>>,
    ]);

    const items = await this.hidratarRespuestas(tenantId, rows);

    return {
      items,
      total: totalRows[0]?.n ?? 0,
      page: filtros.page,
      pageSize: filtros.pageSize,
      pendientes: pendientesRows[0]?.n ?? 0,
    };
  }

  /** Nombres, títulos de curso, lecciones citadas y correcciones, en batch. */
  private async hidratarRespuestas(
    tenantId: string,
    rows: AnswerRow[],
  ): Promise<ReviewAnswerView[]> {
    if (rows.length === 0) return [];

    const userIds = new Set<string>();
    const courseIds = new Set<string>();
    const lessonIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.user_id);
      if (r.reviewed_by_id) userIds.add(r.reviewed_by_id);
      courseIds.add(r.course_id);
      for (const c of leerCitas(r.citations)) {
        if (c.lessonId) lessonIds.add(c.lessonId);
      }
    }

    const [usuarios, cursos, lecciones, correcciones] = await Promise.all([
      this.mapaUsuarios(tenantId, [...userIds]),
      this.mapaCursos(tenantId, [...courseIds]),
      this.mapaLecciones(tenantId, [...lessonIds]),
      this.correccionesPorMensaje(
        tenantId,
        rows.map((r) => r.id),
      ),
    ]);

    return rows.map((r) => {
      const autor = usuarios.get(r.user_id);
      const revisor = r.reviewed_by_id ? usuarios.get(r.reviewed_by_id) : undefined;
      const correccion = correcciones.get(r.id);
      return {
        messageId: r.id,
        conversationId: r.conversation_id,
        // Un assistant sin user delante no debería existir (se escriben en la
        // misma transacción), pero si aparece no tumbamos la pantalla.
        question: r.question ?? '(pregunta no encontrada)',
        answer: r.answer,
        citations: leerCitas(r.citations).map((c) => ({
          lessonId: c.lessonId,
          lessonTitle: c.lessonId ? (lecciones.get(c.lessonId) ?? null) : null,
        })),
        courseId: r.course_id,
        courseTitle: cursos.get(r.course_id) ?? null,
        user: {
          id: r.user_id,
          name: autor?.name ?? null,
          email: autor?.email ?? null,
        },
        askedAt: r.created_at.toISOString(),
        reviewStatus: normalizarEstado(r.review_status),
        reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
        reviewedBy: r.reviewed_by_id ? { id: r.reviewed_by_id, name: revisor?.name ?? null } : null,
        reviewNote: r.review_note,
        correction: correccion
          ? {
              id: correccion.id,
              question: correccion.question,
              answer: correccion.answer,
              active: correccion.active,
            }
          : null,
      };
    });
  }

  // ─── 2. Corregir ──────────────────────────────────────────────────────────

  /**
   * Marca una respuesta como revisada. Si el veredicto es CORRECTED, guarda la
   * respuesta buena como conocimiento validado y desactiva la corrección
   * anterior de ese mismo mensaje (revisar dos veces no debe dejar dos verdades
   * compitiendo por el mismo hueco).
   */
  async review(
    tenantId: string,
    messageId: string,
    dto: ReviewAnswerDto,
    revisorId: string,
  ): Promise<ReviewAnswerView> {
    const mensaje = (await this.prisma.modAiTutorMessage.findFirst({
      where: { id: messageId, tenantId, role: 'assistant' },
      select: { id: true, conversationId: true, createdAt: true },
    })) as { id: string; conversationId: string; createdAt: Date } | null;
    if (!mensaje) throw new MessageNotFoundError(messageId);

    const conversacion = (await this.prisma.modAiTutorConversation.findFirst({
      where: { id: mensaje.conversationId, tenantId },
      select: { courseId: true },
    })) as { courseId: string } | null;
    if (!conversacion) throw new MessageNotFoundError(messageId);

    const preguntaAlumno = await this.preguntaDe(tenantId, mensaje);

    await this.prisma.modAiTutorMessage.update({
      where: { id: messageId },
      data: {
        reviewStatus: dto.status,
        reviewedById: revisorId,
        reviewedAt: new Date(),
        reviewNote: dto.nota ?? null,
      },
    });

    if (dto.status === 'CORRECTED' && dto.respuestaCorregida) {
      // Sólo una corrección viva por mensaje: la última que escribió el revisor.
      await this.prisma.$executeRawUnsafe(
        `UPDATE "mod_ai_tutor_correction"
         SET "active" = false, "updated_at" = NOW()
         WHERE "tenant_id" = $1::uuid AND "source_message_id" = $2::uuid`,
        tenantId,
        messageId,
      );
      await this.crearCorreccion({
        tenantId,
        courseId: dto.aplicaATodosLosCursos ? null : conversacion.courseId,
        pregunta: dto.preguntaCanonica ?? preguntaAlumno ?? '',
        respuesta: dto.respuestaCorregida,
        autorId: revisorId,
        sourceMessageId: messageId,
      });
      await this.publish(tenantId, 'ai-tutor.answer.corrected', {
        messageId,
        courseId: conversacion.courseId,
        revisorId,
        global: !!dto.aplicaATodosLosCursos,
      });
    } else {
      await this.publish(tenantId, 'ai-tutor.answer.reviewed', {
        messageId,
        courseId: conversacion.courseId,
        revisorId,
        status: dto.status,
      });
    }

    const [vista] = await this.hidratarRespuestas(
      tenantId,
      (await this.prisma.$queryRawUnsafe(
        `SELECT
           a."id"::text AS "id",
           a."conversation_id"::text AS "conversation_id",
           a."content" AS "answer",
           a."citations" AS "citations",
           a."created_at" AS "created_at",
           a."review_status" AS "review_status",
           a."reviewed_by_id"::text AS "reviewed_by_id",
           a."reviewed_at" AS "reviewed_at",
           a."review_note" AS "review_note",
           q."content" AS "question",
           conv."user_id"::text AS "user_id",
           conv."course_id"::text AS "course_id"
         FROM "mod_ai_tutor_message" a
         JOIN "mod_ai_tutor_conversation" conv ON conv."id" = a."conversation_id"
         LEFT JOIN LATERAL (
           SELECT m."content" FROM "mod_ai_tutor_message" m
           WHERE m."conversation_id" = a."conversation_id"
             AND m."role" = 'user' AND m."created_at" <= a."created_at"
           ORDER BY m."created_at" DESC LIMIT 1
         ) q ON true
         WHERE a."id" = $1::uuid AND a."tenant_id" = $2::uuid`,
        messageId,
        tenantId,
      )) as AnswerRow[],
    );
    if (!vista) throw new MessageNotFoundError(messageId);
    return vista;
  }

  /** Alta manual de conocimiento validado, sin partir de una respuesta mala. */
  async createCorrection(
    tenantId: string,
    dto: UpsertCorrectionDto,
    autorId: string,
  ): Promise<CorrectionView> {
    const id = await this.crearCorreccion({
      tenantId,
      courseId: dto.courseId ?? null,
      pregunta: dto.pregunta,
      respuesta: dto.respuesta,
      autorId,
      sourceMessageId: null,
    });
    const [vista] = await this.listCorrectionsByIds(tenantId, [id]);
    if (!vista) throw new CorrectionNotFoundError(id);
    return vista;
  }

  /**
   * Edita una corrección. Si cambia la pregunta hay que volver a embeberla: el
   * embedding viejo apuntaría a otra duda y la corrección se dispararía donde
   * no toca.
   */
  async updateCorrection(
    tenantId: string,
    id: string,
    dto: Partial<UpsertCorrectionDto>,
  ): Promise<CorrectionView> {
    const [actual] = await this.listCorrectionsByIds(tenantId, [id]);
    if (!actual) throw new CorrectionNotFoundError(id);

    const pregunta = dto.pregunta ?? actual.question;
    const cambiaPregunta = dto.pregunta !== undefined && dto.pregunta !== actual.question;

    if (cambiaPregunta) {
      const embedding = await this.embed(tenantId, pregunta);
      await this.prisma.$executeRawUnsafe(
        `UPDATE "mod_ai_tutor_correction"
         SET "question" = $1, "embedding" = $2::vector, "updated_at" = NOW()
         WHERE "id" = $3::uuid AND "tenant_id" = $4::uuid`,
        pregunta,
        formatVector(embedding),
        id,
        tenantId,
      );
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE "mod_ai_tutor_correction"
       SET "answer" = $1,
           "course_id" = $2::uuid,
           "active" = $3,
           "updated_at" = NOW()
       WHERE "id" = $4::uuid AND "tenant_id" = $5::uuid`,
      dto.respuesta ?? actual.answer,
      dto.courseId === undefined ? actual.courseId : dto.courseId,
      dto.active ?? actual.active,
      id,
      tenantId,
    );

    const [vista] = await this.listCorrectionsByIds(tenantId, [id]);
    if (!vista) throw new CorrectionNotFoundError(id);
    return vista;
  }

  async deleteCorrection(tenantId: string, id: string): Promise<void> {
    const borradas = (await this.prisma.$executeRawUnsafe(
      `DELETE FROM "mod_ai_tutor_correction" WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
      id,
      tenantId,
    )) as unknown as number;
    if (!borradas) throw new CorrectionNotFoundError(id);
  }

  async listCorrections(
    tenantId: string,
    filtros: { courseId?: string; soloActivas?: boolean } = {},
  ): Promise<CorrectionView[]> {
    const rows = (await this.prisma.modAiTutorCorrection.findMany({
      where: {
        tenantId,
        ...(filtros.courseId ? { courseId: filtros.courseId } : {}),
        ...(filtros.soloActivas ? { active: true } : {}),
      },
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
      select: SELECT_CORRECCION,
      take: 300,
    })) as CorrectionRow[];
    return this.hidratarCorrecciones(tenantId, rows);
  }

  private async listCorrectionsByIds(tenantId: string, ids: string[]): Promise<CorrectionView[]> {
    const rows = (await this.prisma.modAiTutorCorrection.findMany({
      where: { tenantId, id: { in: ids } },
      select: SELECT_CORRECCION,
    })) as CorrectionRow[];
    return this.hidratarCorrecciones(tenantId, rows);
  }

  private async hidratarCorrecciones(
    tenantId: string,
    rows: CorrectionRow[],
  ): Promise<CorrectionView[]> {
    if (rows.length === 0) return [];
    const [cursos, autores] = await Promise.all([
      this.mapaCursos(
        tenantId,
        rows.map((r) => r.courseId).filter((c): c is string => !!c),
      ),
      this.mapaUsuarios(
        tenantId,
        rows.map((r) => r.authorId),
      ),
    ]);
    return rows.map((r) => ({
      id: r.id,
      courseId: r.courseId,
      courseTitle: r.courseId ? (cursos.get(r.courseId) ?? null) : null,
      question: r.question,
      answer: r.answer,
      active: r.active,
      timesUsed: r.timesUsed,
      authorId: r.authorId,
      authorName: autores.get(r.authorId)?.name ?? null,
      sourceMessageId: r.sourceMessageId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** Inserta la fila con su vector. Raw porque Prisma no escribe `vector`. */
  private async crearCorreccion(args: {
    tenantId: string;
    courseId: string | null;
    pregunta: string;
    respuesta: string;
    autorId: string;
    sourceMessageId: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const embedding = await this.embed(args.tenantId, args.pregunta);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "mod_ai_tutor_correction"
       ("id", "tenant_id", "course_id", "question", "answer", "embedding",
        "source_message_id", "author_id", "active", "times_used", "created_at", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::vector, $7::uuid, $8::uuid, true, 0, NOW(), NOW())`,
      id,
      args.tenantId,
      args.courseId,
      args.pregunta,
      args.respuesta,
      formatVector(embedding),
      args.sourceMessageId,
      args.autorId,
    );
    return id;
  }

  // ─── 3. Informe mensual ───────────────────────────────────────────────────

  /**
   * Qué se preguntó en un mes, agrupado por tema y ordenado por volumen.
   *
   * Las preguntas anteriores a la columna `question_embedding` no traen vector.
   * En vez de dejarlas fuera del informe (que sería dejar fuera todo el
   * histórico), se embeben aquí la primera vez y se guardan: el informe del mes
   * pasado sólo cuesta una vez.
   */
  async monthlyReport(tenantId: string, dto: MonthlyReportDto): Promise<MonthlyReportView> {
    const { desde, hasta, mes } = rangoDelMes(dto.mes);

    const params: unknown[] = [tenantId, desde, hasta];
    let filtroCurso = '';
    if (dto.courseId) {
      params.push(dto.courseId);
      filtroCurso = ` AND conv."course_id" = $${params.length}::uuid`;
    }
    params.push(MAX_PREGUNTAS_INFORME);

    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT
         u."id"::text AS "id",
         u."content" AS "question",
         u."question_embedding"::text AS "embedding",
         conv."user_id"::text AS "user_id",
         conv."course_id"::text AS "course_id",
         u."created_at" AS "created_at",
         a."id"::text AS "answer_id",
         a."review_status" AS "review_status",
         (a."citations" IS NULL OR a."citations" = '[]'::jsonb) AS "sin_respaldo"
       FROM "mod_ai_tutor_message" u
       JOIN "mod_ai_tutor_conversation" conv ON conv."id" = u."conversation_id"
       LEFT JOIN LATERAL (
         SELECT m."id", m."review_status", m."citations"
         FROM "mod_ai_tutor_message" m
         WHERE m."conversation_id" = u."conversation_id"
           AND m."role" = 'assistant'
           AND m."created_at" >= u."created_at"
         ORDER BY m."created_at" ASC
         LIMIT 1
       ) a ON true
       WHERE u."tenant_id" = $1::uuid AND u."role" = 'user'
         AND u."created_at" >= $2 AND u."created_at" < $3${filtroCurso}
       ORDER BY u."created_at" ASC
       LIMIT $${params.length}`,
      ...params,
    )) as QuestionRow[];

    const vectores = await this.completarEmbeddings(tenantId, rows);

    const [usuarios, cursos] = await Promise.all([
      this.mapaUsuarios(
        tenantId,
        rows.map((r) => r.user_id),
      ),
      this.mapaCursos(
        tenantId,
        rows.map((r) => r.course_id),
      ),
    ]);

    const clusterables: Array<ClusterableQuestion<QuestionRow>> = [];
    for (const r of rows) {
      const emb = vectores.get(r.id);
      if (!emb || emb.length === 0) continue;
      clusterables.push({ text: r.question, embedding: emb, payload: r });
    }

    const grupos = clusterQuestions(clusterables);

    const temas: ReportTopicView[] = grupos.map((g) => {
      const porAlumno = new Map<string, number>();
      const porCurso = new Map<string, number>();
      let sinRespaldo = 0;
      let pendientes = 0;
      let corregidas = 0;
      for (const m of g.members) {
        const r = m.payload;
        porAlumno.set(r.user_id, (porAlumno.get(r.user_id) ?? 0) + 1);
        porCurso.set(r.course_id, (porCurso.get(r.course_id) ?? 0) + 1);
        if (r.sin_respaldo) sinRespaldo++;
        if (r.review_status === 'PENDING' || r.review_status === null) pendientes++;
        if (r.review_status === 'CORRECTED') corregidas++;
      }
      return {
        pregunta: g.representative.text,
        veces: g.members.length,
        alumnos: porAlumno.size,
        quienes: [...porAlumno.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, veces]) => ({ id, name: usuarios.get(id)?.name ?? null, veces })),
        cursos: [...porCurso.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, veces]) => ({ id, title: cursos.get(id) ?? null, veces })),
        sinRespaldo,
        pendientesDeRevision: pendientes,
        corregidas,
        variantes: g.members
          .map((m) => m.text)
          .filter((t) => t !== g.representative.text)
          .slice(0, 5),
        messageIds: g.members
          .map((m) => m.payload.answer_id)
          .filter((id): id is string => !!id)
          .slice(0, 20),
      };
    });

    const alumnosGlobal = new Map<string, number>();
    for (const r of rows) alumnosGlobal.set(r.user_id, (alumnosGlobal.get(r.user_id) ?? 0) + 1);

    return {
      mes,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      totalPreguntas: rows.length,
      alumnosActivos: alumnosGlobal.size,
      sinRespaldo: rows.filter((r) => r.sin_respaldo).length,
      pendientesDeRevision: rows.filter(
        (r) => r.review_status === 'PENDING' || r.review_status === null,
      ).length,
      corregidas: rows.filter((r) => r.review_status === 'CORRECTED').length,
      temas,
      topAlumnos: [...alumnosGlobal.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, veces]) => ({ id, name: usuarios.get(id)?.name ?? null, veces })),
      truncado: rows.length >= MAX_PREGUNTAS_INFORME,
    };
  }

  /**
   * Devuelve el embedding de cada pregunta, calculando y persistiendo los que
   * falten. Si el proveedor falla se sigue con lo que haya: un informe con
   * menos temas es mejor que una pantalla de error.
   */
  private async completarEmbeddings(
    tenantId: string,
    rows: QuestionRow[],
  ): Promise<Map<string, number[]>> {
    const mapa = new Map<string, number[]>();
    const faltan: QuestionRow[] = [];
    for (const r of rows) {
      const v = parseVector(r.embedding);
      if (v.length > 0) mapa.set(r.id, v);
      else faltan.push(r);
    }
    if (faltan.length === 0) return mapa;

    this.ctx.logger.info('mod.ai-tutor: rellenando embeddings de preguntas antiguas', {
      tenantId,
      pendientes: faltan.length,
    });

    for (let i = 0; i < faltan.length; i += EMBED_BATCH) {
      const lote = faltan.slice(i, i + EMBED_BATCH);
      try {
        const res = await this.embedFn({ tenantId, texts: lote.map((r) => r.question) });
        for (let j = 0; j < lote.length; j++) {
          const emb = res.embeddings[j];
          if (!emb) continue;
          mapa.set(lote[j]!.id, emb);
          await this.prisma.$executeRawUnsafe(
            `UPDATE "mod_ai_tutor_message" SET "question_embedding" = $1::vector WHERE "id" = $2::uuid`,
            formatVector(emb),
            lote[j]!.id,
          );
        }
      } catch (err) {
        this.ctx.logger.warn('mod.ai-tutor: no se pudo embeber un lote del informe', {
          tenantId,
          reason: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    return mapa;
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────

  private async embed(tenantId: string, texto: string): Promise<number[]> {
    const res = await this.embedFn({ tenantId, texts: [texto] });
    const emb = res.embeddings[0];
    if (!emb || emb.length === 0) {
      throw new EmbeddingsProviderError('gateway', 'embed devolvió 0 vectores');
    }
    return emb;
  }

  /** Texto de la pregunta que precede a una respuesta del tutor. */
  private async preguntaDe(
    tenantId: string,
    mensaje: { conversationId: string; createdAt: Date },
  ): Promise<string | null> {
    const previo = (await this.prisma.modAiTutorMessage.findFirst({
      where: {
        tenantId,
        conversationId: mensaje.conversationId,
        role: 'user',
        createdAt: { lte: mensaje.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    })) as { content: string } | null;
    return previo?.content ?? null;
  }

  private async correccionesPorMensaje(
    tenantId: string,
    messageIds: string[],
  ): Promise<Map<string, CorrectionRow>> {
    const mapa = new Map<string, CorrectionRow>();
    if (messageIds.length === 0) return mapa;
    const rows = (await this.prisma.modAiTutorCorrection.findMany({
      where: { tenantId, sourceMessageId: { in: messageIds }, active: true },
      select: SELECT_CORRECCION,
    })) as CorrectionRow[];
    for (const r of rows) {
      if (r.sourceMessageId) mapa.set(r.sourceMessageId, r);
    }
    return mapa;
  }

  private async mapaUsuarios(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, { name: string | null; email: string | null }>> {
    const mapa = new Map<string, { name: string | null; email: string | null }>();
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return mapa;
    try {
      const rows = await this.prisma.user.findMany({
        where: { tenantId, id: { in: unicos } },
        select: { id: true, name: true, email: true },
      });
      for (const r of rows) mapa.set(r.id, { name: r.name, email: r.email });
    } catch {
      /* sin nombres la pantalla sigue siendo útil */
    }
    return mapa;
  }

  private async mapaCursos(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const mapa = new Map<string, string>();
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return mapa;
    try {
      const rows = await this.prisma.modCoursesCourse.findMany({
        where: { tenantId, id: { in: unicos } },
        select: { id: true, title: true },
      });
      for (const r of rows) mapa.set(r.id, r.title);
    } catch {
      /* idem */
    }
    return mapa;
  }

  private async mapaLecciones(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const mapa = new Map<string, string>();
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return mapa;
    try {
      const rows = await this.prisma.modCoursesLesson.findMany({
        where: { tenantId, id: { in: unicos } },
        select: { id: true, title: true },
      });
      for (const r of rows) mapa.set(r.id, r.title);
    } catch {
      /* idem */
    }
    return mapa;
  }

  private async publish(
    tenantId: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.ctx.eventBus.publish({
      name,
      version: 1,
      data,
      metadata: {
        tenantId,
        timestamp: new Date().toISOString(),
        traceId: randomUUID(),
        idempotencyKey: `${name}:${JSON.stringify(data)}:${Date.now()}`,
      },
    });
  }
}

const SELECT_CORRECCION = {
  id: true,
  courseId: true,
  question: true,
  answer: true,
  active: true,
  timesUsed: true,
  authorId: true,
  sourceMessageId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizarEstado(raw: string | null): ReviewStatus {
  return raw === 'OK' || raw === 'CORRECTED' ? raw : 'PENDING';
}

/** Citas persistidas: `[{ index, lessonId, chunkId }]`. Tolerante a basura. */
function leerCitas(raw: unknown): Array<{ lessonId: string | null }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const obj = c as { lessonId?: unknown };
    return { lessonId: typeof obj?.lessonId === 'string' ? obj.lessonId : null };
  });
}

/**
 * Primer y último instante del mes pedido, en UTC. Sin `mes` devuelve el mes en
 * curso. El límite superior es exclusivo para no contar dos veces el día 1.
 */
export function rangoDelMes(mes?: string): { desde: Date; hasta: Date; mes: string } {
  const ahora = new Date();
  let anio = ahora.getUTCFullYear();
  let mesIdx = ahora.getUTCMonth();
  if (mes) {
    const [a, m] = mes.split('-');
    anio = Number(a);
    mesIdx = Number(m) - 1;
  }
  const desde = new Date(Date.UTC(anio, mesIdx, 1, 0, 0, 0, 0));
  const hasta = new Date(Date.UTC(anio, mesIdx + 1, 1, 0, 0, 0, 0));
  return {
    desde,
    hasta,
    mes: `${anio}-${String(mesIdx + 1).padStart(2, '0')}`,
  };
}
