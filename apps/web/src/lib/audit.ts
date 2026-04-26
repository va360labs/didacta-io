'use client';

import { apiFetch } from './api-client';

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  timestamp: string;
}

export interface ChainVerifyResult {
  valid: boolean;
  totalEntries: number;
  firstBrokenId: string | null;
  brokenAt: string | null;
}

export interface AuditFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

function buildQuery(filters: AuditFilters): string {
  const usp = new URLSearchParams();
  if (filters.actorId) usp.set('actorId', filters.actorId);
  if (filters.action) usp.set('action', filters.action);
  if (filters.resourceType) usp.set('resourceType', filters.resourceType);
  if (filters.dateFrom) usp.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) usp.set('dateTo', filters.dateTo);
  if (filters.limit) usp.set('limit', String(filters.limit));
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

export const auditApi = {
  async list(bearer: string, filters: AuditFilters = {}): Promise<AuditEntry[]> {
    return apiFetch<AuditEntry[]>(
      `/api/v1/audit/entries${buildQuery(filters)}`,
      { method: 'GET' },
      bearer,
    );
  },
  async verify(bearer: string): Promise<ChainVerifyResult> {
    return apiFetch<ChainVerifyResult>('/api/v1/audit/verify', { method: 'GET' }, bearer);
  },
};

/**
 * Convierte el array de entries a CSV para descarga client-side.
 * Comilla los campos con comillas dobles + escapa las internas.
 */
export function entriesToCsv(entries: AuditEntry[]): string {
  const header = ['timestamp', 'actor_id', 'action', 'resource_type', 'resource_id', 'ip'];
  const escape = (v: string | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const rows = entries.map((e) =>
    [e.timestamp, e.actorId, e.action, e.resourceType, e.resourceId, e.ip].map(escape).join(','),
  );
  return [header.join(','), ...rows].join('\n');
}
