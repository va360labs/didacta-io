/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Cliente HTTP de la retención de mod.gamification: desbloqueo por nivel,
 * rachas, insignias, premios automáticos y celebraciones.
 */

const BASE = '/api/v1/modules/gamification';

export type BadgeKind = 'first_post' | 'first_comment' | 'first_course' | 'streak_days' | 'level';
export type LockTargetKind = 'COURSE' | 'MODULE';
export type RewardTrigger = 'LEVEL' | 'POINTS';
export type RewardKind = 'MESSAGE' | 'CODE';

export interface StreakView {
  currentDays: number;
  bestDays: number;
  currentWeeks: number;
  bestWeeks: number;
  activeToday: boolean;
  lastDay: string | null;
}

export interface BadgeView {
  key: string;
  kind: BadgeKind;
  threshold: number;
  /** null = nombre por defecto (lo traduce la interfaz). */
  name: string | null;
  enabled: boolean;
}

export interface EarnedBadge {
  key: string;
  kind: BadgeKind;
  threshold: number;
  name: string | null;
  awardedAt: string;
}

export interface MemberPrefs {
  celebrate: boolean;
  showStreak: boolean;
}

export interface MyRetention {
  settings: { streaksEnabled: boolean; badgesEnabled: boolean };
  prefs: MemberPrefs;
  streak: StreakView | null;
  levelNumber: number;
  badges: EarnedBadge[];
  catalog: BadgeView[];
}

export interface MemberSummary {
  userId: string;
  levelNumber: number;
  levelName: string | null;
  badges: EarnedBadge[];
  streak: StreakView | null;
}

export interface MyLock {
  id: string;
  targetKind: LockTargetKind;
  targetId: string;
  courseId: string;
  levelNumber: number;
  levelName: string;
  minPoints: number;
  pointsMissing: number;
  unlocked: boolean;
}

export interface DeliveredReward {
  title: string;
  kind: RewardKind;
  message: string | null;
  url: string | null;
  code: string | null;
}

export interface RewardGrant {
  id: string;
  rewardId: string;
  userId: string;
  grantedAt: string;
  delivered: DeliveredReward;
  displayName?: string | null;
}

export interface UpcomingReward {
  id: string;
  title: string;
  kind: RewardKind;
  triggerKind: RewardTrigger;
  levelName: string | null;
  levelNumber: number | null;
  points: number | null;
  pointsMissing: number;
}

export interface RetentionSettings {
  streaksEnabled: boolean;
  badgesEnabled: boolean;
  celebrateCourses: boolean;
  celebrateIntros: boolean;
  celebrateAnniversaries: boolean;
  celebrateLevels: boolean;
}

export interface ContentLock {
  id: string;
  targetKind: LockTargetKind;
  targetId: string;
  courseId: string;
  levelId: string;
  levelName: string;
  levelNumber: number;
  minPoints: number;
  grantPaid: boolean;
}

export interface LockableCourse {
  id: string;
  title: string;
  status: string;
  paid: boolean;
  modules: Array<{ id: string; title: string }>;
}

export interface Reward {
  id: string;
  title: string;
  triggerKind: RewardTrigger;
  levelId: string | null;
  levelName: string | null;
  levelNumber: number | null;
  points: number | null;
  kind: RewardKind;
  message: string | null;
  url: string | null;
  code: string | null;
  active: boolean;
  grantCount: number;
}

export interface RewardInput {
  title: string;
  triggerKind: RewardTrigger;
  levelId?: string | null;
  points?: number | null;
  kind: RewardKind;
  message?: string | null;
  url?: string | null;
  code?: string | null;
  active?: boolean;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

const get = <T>(path: string) => apiFetch<T>(`${BASE}${path}`, { method: 'GET' }, withAuth());
const send = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
  apiFetch<T>(
    `${BASE}${path}`,
    { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    withAuth(),
  );

/** Lo que ve y decide cada miembro. */
export const retentionApi = {
  myRetention: () => get<MyRetention>('/me/retention'),
  updatePrefs: (patch: Partial<MemberPrefs>) => send<MemberPrefs>('PUT', '/me/prefs', patch),
  myRewards: () => get<{ earned: RewardGrant[]; upcoming: UpcomingReward[] }>('/me/rewards'),
  async myLocks(): Promise<MyLock[]> {
    return (await get<{ locks: MyLock[] }>('/me/locks')).locks;
  },
  memberSummary: (userId: string) => get<MemberSummary>(`/members/${userId}/summary`),
  async membersSummary(ids: string[]): Promise<MemberSummary[]> {
    if (ids.length === 0) return [];
    const qs = encodeURIComponent(ids.join(','));
    return (await get<{ members: MemberSummary[] }>(`/members/summary?ids=${qs}`)).members;
  },
};

/** Panel del creador («Premios y niveles»). */
export const retentionAdminApi = {
  getSettings: () => get<RetentionSettings>('/admin/retention/settings'),
  updateSettings: (patch: Partial<RetentionSettings>) =>
    send<RetentionSettings>('PUT', '/admin/retention/settings', patch),
  async listBadges(): Promise<BadgeView[]> {
    return (await get<{ badges: BadgeView[] }>('/admin/badges')).badges;
  },
  updateBadge: (key: string, patch: { name?: string | null; enabled?: boolean }) =>
    send<BadgeView>('PUT', `/admin/badges/${encodeURIComponent(key)}`, patch),
  async lockableContent(): Promise<LockableCourse[]> {
    return (await get<{ courses: LockableCourse[] }>('/admin/lockable-content')).courses;
  },
  async listLocks(): Promise<ContentLock[]> {
    return (await get<{ locks: ContentLock[] }>('/admin/locks')).locks;
  },
  setLock: (body: {
    targetKind: LockTargetKind;
    targetId: string;
    levelId: string;
    grantPaid?: boolean;
  }) => send<ContentLock>('PUT', '/admin/locks', body),
  removeLock: (id: string) => send<void>('DELETE', `/admin/locks/${id}`),
  /**
   * Premios del aula y si admite códigos de descuento: en el modo plataforma
   * (Didacta Cloud) el checkout los rechaza y la interfaz no los ofrece.
   */
  async listRewards(): Promise<{ rewards: Reward[]; codesAllowed: boolean }> {
    const res = await get<{ rewards: Reward[]; codesAllowed?: boolean }>('/admin/rewards');
    return { rewards: res.rewards, codesAllowed: res.codesAllowed !== false };
  },
  createReward: (body: RewardInput) => send<Reward>('POST', '/admin/rewards', body),
  updateReward: (id: string, patch: Partial<RewardInput>) =>
    send<Reward>('PUT', `/admin/rewards/${id}`, patch),
  deleteReward: (id: string) => send<void>('DELETE', `/admin/rewards/${id}`),
  async listGrants(): Promise<RewardGrant[]> {
    return (await get<{ grants: RewardGrant[] }>('/admin/reward-grants')).grants;
  },
};
