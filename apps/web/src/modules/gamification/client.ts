import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/** Cliente HTTP de mod.gamification (bloque 1 — puntos, niveles y retos). */

const BASE = '/api/v1/modules/gamification';

export type LeaderboardRange = 'week' | 'month' | 'all';
export type ChallengeStatus = 'DRAFT' | 'OPEN' | 'CLOSED';
export type SubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface LeaderboardEntry {
  userId: string;
  rank: number;
  points: number;
  displayName: string;
}

export interface Standing {
  points: number;
  rank: number | null;
  total: number;
  lifetimePoints: number;
  levelKey: string | null;
  levelName: string | null;
}

export interface LedgerEntry {
  id: string;
  ruleKey: string;
  points: number;
  occurredAt: string;
  revoked: boolean;
}

export interface RuleView {
  key: string;
  points: number;
  dailyCap: number;
  enabled: boolean;
}

export interface LevelView {
  id: string;
  key: string;
  name: string;
  minPoints: number;
  benefitText: string | null;
}

export type PerkRequestStatus = 'PENDING' | 'APPROVED' | 'DONE' | 'REJECTED';

export interface PerkView {
  id: string;
  levelId: string;
  levelName: string;
  levelMinPoints: number;
  title: string;
  description: string | null;
  maxPerUser: number;
  cooldownDays: number;
  active: boolean;
}

export interface MyPerkView {
  id: string;
  title: string;
  description: string | null;
  levelId: string;
  levelName: string;
  levelMinPoints: number;
  unlocked: boolean;
  canRequest: boolean;
  quotaLeft: number | null;
  /** Tope por persona; 0 = sin tope. */
  maxPerUser: number;
  /** Días de espera entre solicitudes; 0 = ninguna. */
  cooldownDays: number;
  availableAt: string | null;
  lastRequestStatus: PerkRequestStatus | null;
}

export interface PerkRequestView {
  id: string;
  perkId: string;
  perkTitle: string;
  userId: string;
  displayName: string;
  note: string | null;
  status: PerkRequestStatus;
  staffNote: string | null;
  handledAt: string | null;
  createdAt: string;
}

export interface ChallengeView {
  id: string;
  title: string;
  description: string | null;
  points: number;
  proofRequired: boolean;
  status: ChallengeStatus;
  startsAt: string | null;
  endsAt: string | null;
  submissionCount?: number;
  mySubmission?: { id: string; status: SubmissionStatus; reviewNote: string | null } | null;
}

export interface SubmissionView {
  id: string;
  challengeId: string;
  challengeTitle: string;
  userId: string;
  displayName: string;
  proofUrl: string | null;
  proofName: string | null;
  note: string | null;
  status: SubmissionStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface BackfillSummary {
  posts: number;
  comments: number;
  resources: number;
  courses: number;
  referrals: number;
  awarded: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const gamificationApi = {
  async leaderboard(
    range: LeaderboardRange = 'all',
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    return apiFetch<{ entries: LeaderboardEntry[]; total: number }>(
      `${BASE}/leaderboard?range=${range}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async myStanding(range: LeaderboardRange = 'all'): Promise<Standing> {
    return apiFetch<Standing>(`${BASE}/me?range=${range}`, { method: 'GET' }, withAuth());
  },

  async myHistory(): Promise<LedgerEntry[]> {
    const res = await apiFetch<{ entries: LedgerEntry[] }>(
      `${BASE}/me/history`,
      { method: 'GET' },
      withAuth(),
    );
    return res.entries;
  },

  async listLevels(): Promise<LevelView[]> {
    const res = await apiFetch<{ levels: LevelView[] }>(
      `${BASE}/levels`,
      { method: 'GET' },
      withAuth(),
    );
    return res.levels;
  },

  async listChallenges(): Promise<ChallengeView[]> {
    const res = await apiFetch<{ challenges: ChallengeView[] }>(
      `${BASE}/challenges`,
      { method: 'GET' },
      withAuth(),
    );
    return res.challenges;
  },

  async myPerks(): Promise<MyPerkView[]> {
    const res = await apiFetch<{ perks: MyPerkView[] }>(
      `${BASE}/me/perks`,
      { method: 'GET' },
      withAuth(),
    );
    return res.perks;
  },

  async requestPerk(
    perkId: string,
    body: { note?: string },
  ): Promise<{ id: string; status: PerkRequestStatus }> {
    return apiFetch<{ id: string; status: PerkRequestStatus }>(
      `${BASE}/perks/${perkId}/request`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async submit(
    challengeId: string,
    body: { proofUrl?: string; proofName?: string; note?: string },
  ): Promise<{ id: string; status: SubmissionStatus }> {
    return apiFetch<{ id: string; status: SubmissionStatus }>(
      `${BASE}/challenges/${challengeId}/submit`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },
};

/** Endpoints del panel del operador. */
export const gamificationAdminApi = {
  async listRules(): Promise<RuleView[]> {
    const res = await apiFetch<{ rules: RuleView[] }>(
      `${BASE}/admin/rules`,
      { method: 'GET' },
      withAuth(),
    );
    return res.rules;
  },

  async updateRule(
    key: string,
    patch: { points?: number; dailyCap?: number; enabled?: boolean },
  ): Promise<RuleView> {
    return apiFetch<RuleView>(
      `${BASE}/admin/rules/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify(patch) },
      withAuth(),
    );
  },

  async createLevel(body: {
    key: string;
    name: string;
    minPoints: number;
    benefitText?: string;
  }): Promise<LevelView> {
    return apiFetch<LevelView>(
      `${BASE}/admin/levels`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async updateLevel(
    id: string,
    body: {
      name?: string;
      minPoints?: number;
      benefitText?: string | null;
    },
  ): Promise<LevelView> {
    return apiFetch<LevelView>(
      `${BASE}/admin/levels/${id}`,
      { method: 'PUT', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async deleteLevel(id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/admin/levels/${id}`, { method: 'DELETE' }, withAuth());
  },

  async listPerks(): Promise<PerkView[]> {
    const res = await apiFetch<{ perks: PerkView[] }>(
      `${BASE}/admin/perks`,
      { method: 'GET' },
      withAuth(),
    );
    return res.perks;
  },

  async createPerk(body: {
    levelId: string;
    title: string;
    description?: string;
    maxPerUser?: number;
    cooldownDays?: number;
  }): Promise<PerkView> {
    return apiFetch<PerkView>(
      `${BASE}/admin/perks`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async updatePerk(
    id: string,
    body: { title?: string; maxPerUser?: number; cooldownDays?: number; active?: boolean },
  ): Promise<void> {
    await apiFetch<void>(
      `${BASE}/admin/perks/${id}`,
      { method: 'PUT', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async deletePerk(id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/admin/perks/${id}`, { method: 'DELETE' }, withAuth());
  },

  async listPerkRequests(status?: PerkRequestStatus): Promise<PerkRequestView[]> {
    const qs = status ? `?status=${status}` : '';
    const res = await apiFetch<{ requests: PerkRequestView[] }>(
      `${BASE}/admin/perk-requests${qs}`,
      { method: 'GET' },
      withAuth(),
    );
    return res.requests;
  },

  async handlePerkRequest(
    id: string,
    body: { status: 'APPROVED' | 'DONE' | 'REJECTED'; staffNote?: string },
  ): Promise<{ status: PerkRequestStatus }> {
    return apiFetch<{ status: PerkRequestStatus }>(
      `${BASE}/admin/perk-requests/${id}/handle`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async listChallenges(): Promise<ChallengeView[]> {
    const res = await apiFetch<{ challenges: ChallengeView[] }>(
      `${BASE}/admin/challenges`,
      { method: 'GET' },
      withAuth(),
    );
    return res.challenges;
  },

  async createChallenge(body: {
    title: string;
    description?: string;
    points: number;
    proofRequired?: boolean;
    status?: ChallengeStatus;
    startsAt?: string | null;
    endsAt?: string | null;
  }): Promise<ChallengeView> {
    return apiFetch<ChallengeView>(
      `${BASE}/admin/challenges`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async updateChallenge(
    id: string,
    body: {
      title?: string;
      description?: string;
      points?: number;
      proofRequired?: boolean;
      status?: ChallengeStatus;
      startsAt?: string | null;
      endsAt?: string | null;
    },
  ): Promise<void> {
    await apiFetch<void>(
      `${BASE}/admin/challenges/${id}`,
      { method: 'PUT', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async deleteChallenge(id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/admin/challenges/${id}`, { method: 'DELETE' }, withAuth());
  },

  async listSubmissions(status?: SubmissionStatus): Promise<SubmissionView[]> {
    const qs = status ? `?status=${status}` : '';
    const res = await apiFetch<{ submissions: SubmissionView[] }>(
      `${BASE}/admin/submissions${qs}`,
      { method: 'GET' },
      withAuth(),
    );
    return res.submissions;
  },

  async review(
    id: string,
    body: { approve: boolean; reviewNote?: string },
  ): Promise<{ status: SubmissionStatus; awarded: boolean }> {
    return apiFetch<{ status: SubmissionStatus; awarded: boolean }>(
      `${BASE}/admin/submissions/${id}/review`,
      { method: 'POST', body: JSON.stringify(body) },
      withAuth(),
    );
  },

  async runBackfill(): Promise<BackfillSummary> {
    return apiFetch<BackfillSummary>(`${BASE}/admin/backfill`, { method: 'POST' }, withAuth());
  },
};
