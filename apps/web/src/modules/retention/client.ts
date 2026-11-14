/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/** Cliente HTTP de mod.retention (mensajes automáticos y miembros en riesgo). */

const BASE = '/api/v1/modules/retention/admin';

export type RetentionTrigger =
  | 'WELCOME'
  | 'DAYS_AFTER_JOIN'
  | 'INACTIVE'
  | 'COURSE_COMPLETED'
  | 'FIRST_POST'
  | 'LEVEL_UP'
  | 'ANNIVERSARY';

export const RETENTION_TRIGGERS: readonly RetentionTrigger[] = [
  'WELCOME',
  'DAYS_AFTER_JOIN',
  'INACTIVE',
  'COURSE_COMPLETED',
  'FIRST_POST',
  'LEVEL_UP',
  'ANNIVERSARY',
];

export interface AutomationStats {
  sent: number;
  read: number;
  replied: number;
  pending: number;
  skipped: number;
  failed: number;
  emailed: number;
}

export interface Automation {
  id: string;
  trigger: RetentionTrigger;
  name: string;
  templateKey: string | null;
  days: number | null;
  resendAfterDays: number | null;
  body: string;
  emailEnabled: boolean;
  emailSubject: string | null;
  enabled: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: AutomationStats;
}

export interface AutomationDraft {
  trigger: RetentionTrigger;
  name: string;
  days: number | null;
  resendAfterDays: number | null;
  body: string;
  emailEnabled: boolean;
  emailSubject: string | null;
  enabled?: boolean;
}

export interface RetentionTemplate {
  key: string;
  trigger: RetentionTrigger;
  days: number | null;
  resendAfterDays: number | null;
  name: string;
  subject: string;
  body: string;
  unavailableReason: 'module_disabled' | null;
  automationId: string | null;
}

export interface StaffMember {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface RetentionSettings {
  sender: StaffMember | null;
  senderUserId: string | null;
  staff: StaffMember[];
  manualCooldownHours: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
}

export interface PreviewResult {
  body: string;
  subject: string;
  recipient: { id: string; name: string };
}

export type AtRiskReasonKind = 'inactive' | 'paid_not_started' | 'stalled';

export type AtRiskReason =
  | { kind: 'inactive'; days: number; neverEntered: boolean }
  | { kind: 'paid_not_started'; paidAt: string }
  | {
      kind: 'stalled';
      courseTitle: string;
      courseUrl: string;
      progressPercent: number;
      lastActivityAt: string | null;
    };

export interface AtRiskRow {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  joinedAt: string;
  lastActiveAt: string | null;
  reasons: AtRiskReason[];
  lastAutomatedAt: string | null;
  inRecovery: boolean;
}

export interface AtRiskResult {
  days: number;
  rows: AtRiskRow[];
  counts: Record<'all' | AtRiskReasonKind, number>;
  recovery: { automationId: string | null };
}

function token(): string {
  const t = authStorage.getAccessToken();
  if (!t)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return t;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export const retentionApi = {
  settings(): Promise<RetentionSettings> {
    return apiFetch<RetentionSettings>(`${BASE}/settings`, { method: 'GET' }, token());
  },
  saveSettings(
    patch: Partial<Omit<RetentionSettings, 'sender' | 'staff'>>,
  ): Promise<RetentionSettings> {
    return apiFetch<RetentionSettings>(
      `${BASE}/settings`,
      { method: 'PUT', body: JSON.stringify(patch) },
      token(),
    );
  },
  async templates(): Promise<RetentionTemplate[]> {
    const res = await apiFetch<{ templates: RetentionTemplate[] }>(
      `${BASE}/templates`,
      { method: 'GET' },
      token(),
    );
    return res.templates;
  },
  async activateTemplate(key: string): Promise<Automation> {
    const res = await apiFetch<{ automation: Automation }>(
      `${BASE}/templates/${encodeURIComponent(key)}/activate`,
      { method: 'POST', body: '{}' },
      token(),
    );
    return res.automation;
  },
  async list(): Promise<Automation[]> {
    const res = await apiFetch<{ automations: Automation[] }>(
      `${BASE}/automations`,
      { method: 'GET' },
      token(),
    );
    return res.automations;
  },
  async create(draft: AutomationDraft): Promise<Automation> {
    const res = await apiFetch<{ automation: Automation }>(
      `${BASE}/automations`,
      json(draft),
      token(),
    );
    return res.automation;
  },
  async update(id: string, patch: Partial<Omit<AutomationDraft, 'trigger'>>): Promise<Automation> {
    const res = await apiFetch<{ automation: Automation }>(
      `${BASE}/automations/${id}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      token(),
    );
    return res.automation;
  },
  async remove(id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/automations/${id}`, { method: 'DELETE' }, token());
  },
  preview(input: {
    trigger: RetentionTrigger;
    body: string;
    subject?: string | null;
    userId?: string | null;
  }): Promise<PreviewResult> {
    return apiFetch<PreviewResult>(`${BASE}/preview`, json(input), token());
  },
  atRisk(query: {
    days?: number;
    reason?: AtRiskReasonKind | null;
    search?: string;
  }): Promise<AtRiskResult> {
    const qs = new URLSearchParams();
    if (query.days) qs.set('days', String(query.days));
    if (query.reason) qs.set('reason', query.reason);
    if (query.search?.trim()) qs.set('search', query.search.trim());
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiFetch<AtRiskResult>(`${BASE}/at-risk${suffix}`, { method: 'GET' }, token());
  },
  addToRecovery(userId: string): Promise<{ queued: boolean; automationId: string }> {
    return apiFetch<{ queued: boolean; automationId: string }>(
      `${BASE}/at-risk/${userId}/recovery`,
      { method: 'POST', body: '{}' },
      token(),
    );
  },
};

/** El módulo está apagado en el aula (el interceptor de módulos responde 403). */
export function isModuleOff(err: unknown): boolean {
  return err instanceof ApiHttpError && err.code === 'TENANT_MODULES_MODULE_NOT_ACTIVE';
}
