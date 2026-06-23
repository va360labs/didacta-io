'use client';

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  points: number;
}

export type LeaderboardRange = 'week' | 'month' | 'all';

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');
  return token;
}

export const leaderboardApi = {
  async get(range: LeaderboardRange = 'all'): Promise<LeaderboardEntry[]> {
    const token = withAuth();
    return apiFetch<LeaderboardEntry[]>(
      `/api/v1/leaderboard?range=${range}`,
      { method: 'GET' },
      token,
    );
  },
};
