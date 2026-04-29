import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';

export { manifest };
export {
  askSchema,
  indexCourseSchema,
  type AskDto,
  type AskResponseView,
  type ChunkView,
  type CitationView,
  type IndexCourseDto,
  type IndexCourseResultView,
} from './dto.js';
export {
  AiTutorError,
  ChatProviderError,
  CourseNotIndexedError,
  CourseNotPublishedError,
  EmbeddingsProviderError,
  TokenQuotaExceededError,
} from './errors.js';
export { chunkText, type Chunk, type ChunkerOptions } from './chunker.js';
export {
  extractLessonText,
  type ExtractInput,
  type ExtractResult,
  type LessonType,
} from './lesson-extractor.js';
export { AiTutorIndexerService, type EmbedFn, type IndexCourseOptions } from './indexer.service.js';

export const aiTutorModule: DidactaModule = {
  manifest,
  async onRegister(ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onRegister', { name: manifest.name });
  },
  async onEnable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onEnable', { tenantId });
  },
  async onDisable(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onDisable', { tenantId });
  },
  async onUninstall(tenantId: string, ctx: ModuleContext) {
    ctx.logger.info('mod.ai-tutor: onUninstall', { tenantId });
  },
};
