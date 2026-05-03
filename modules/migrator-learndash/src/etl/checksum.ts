import { createHash } from 'node:crypto';
import stableStringify from 'fast-json-stable-stringify';

export function computeChecksum(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function computeAuditHash(prevHash: string | null, body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify({ prevHash: prevHash ?? '', body }))
    .digest('hex');
}
