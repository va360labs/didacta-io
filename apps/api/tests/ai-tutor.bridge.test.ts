import { describe, expect, it, vi } from 'vitest';
import { AiTutorBridge } from '../src/modules/ai-tutor/ai-tutor.bridge';

/**
 * El puente del tutor ante un aula SIN proveedor de IA (todas las de Didacta
 * Cloud al nacer). Antes intentaba indexar en cada publicación y cada lección
 * guardada, fallaba y dejaba un `error` («fallo al indexar…») en el log: ruido
 * que tapaba los errores de verdad. Ahora ni lo intenta.
 */

type Handler = (event: {
  metadata: { tenantId: string };
  data: Record<string, string>;
}) => Promise<void>;

function montar(configurado: boolean | undefined) {
  const handlers = new Map<string, Handler>();
  const factory = {
    getEventBus: () => ({
      subscribe: (name: string, h: Handler) => handlers.set(name, h),
    }),
  };
  const indexer = {
    indexCourse: vi.fn(async () => ({})),
    indexLesson: vi.fn(async () => ({ skipped: null })),
    unindexCourse: vi.fn(async () => undefined),
    unindexLesson: vi.fn(async () => undefined),
  };
  const registry = { getAiTutorIndexerServiceOrNull: () => indexer };
  const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const ai =
    configurado === undefined ? undefined : { isConfigured: vi.fn(async () => configurado) };
  const bridge = new AiTutorBridge(
    factory as never,
    registry as never,
    logger as never,
    ai as never,
  );
  bridge.onModuleInit();
  const emitir = (name: string, data: Record<string, string>) =>
    handlers.get(name)!({ metadata: { tenantId: 'tenant-1' }, data });
  return { indexer, logger, ai, emitir };
}

describe('AiTutorBridge · aula sin proveedor de IA', () => {
  it('publicar un curso NO intenta indexar ni deja un error en el log', async () => {
    const { indexer, logger, ai, emitir } = montar(false);
    await emitir('courses.course.published', { courseId: 'c1' });
    expect(ai!.isConfigured).toHaveBeenCalledWith('tenant-1', 'embed');
    expect(indexer.indexCourse).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('guardar una lección tampoco', async () => {
    const { indexer, logger, emitir } = montar(false);
    await emitir('courses.lesson.created', { lessonId: 'l1' });
    await emitir('courses.lesson.updated', { lessonId: 'l1' });
    expect(indexer.indexLesson).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CONTROL: con proveedor sí indexa (el salto discrimina)', async () => {
    const { indexer, emitir } = montar(true);
    await emitir('courses.course.published', { courseId: 'c1' });
    await emitir('courses.lesson.updated', { lessonId: 'l1' });
    expect(indexer.indexCourse).toHaveBeenCalledWith('tenant-1', 'c1');
    expect(indexer.indexLesson).toHaveBeenCalledWith('tenant-1', 'l1');
  });

  it('con proveedor y un fallo real del indexador, el error SÍ se registra', async () => {
    const { indexer, logger, emitir } = montar(true);
    indexer.indexCourse.mockRejectedValueOnce(new Error('cuota agotada'));
    await emitir('courses.course.published', { courseId: 'c1' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
