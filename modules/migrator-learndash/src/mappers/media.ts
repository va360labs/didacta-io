import type { WpMedia } from '../connector/index.js';
import type { CanonicalMedia, MapResult } from './canonical.js';
import { externalId } from './helpers.js';

export function mapMedia(raw: WpMedia): MapResult<CanonicalMedia> {
  const warnings: string[] = [];
  if (!raw || typeof raw.id !== 'number') {
    return { ok: false, errorCode: 'MALFORMED_PAYLOAD', errorMessage: 'media sin id', warnings };
  }
  if (!raw.source_url) {
    return {
      ok: false,
      errorCode: 'MISSING_SOURCE_URL',
      errorMessage: `media ${raw.id} sin source_url`,
      warnings,
    };
  }
  return {
    ok: true,
    warnings,
    canonical: {
      externalId: externalId(raw.id),
      sourceId: String(raw.id),
      sourceUrl: raw.source_url,
      mimeType: raw.mime_type,
      sizeBytes: raw.media_details?.filesize,
      width: raw.media_details?.width,
      height: raw.media_details?.height,
    },
  };
}
