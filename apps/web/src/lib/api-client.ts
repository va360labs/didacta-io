/**
 * Cliente HTTP mínimo para hablar con la API.
 * En el server (RSC, server actions) lee API_URL del env.
 * En el cliente (use client) usa NEXT_PUBLIC_API_URL.
 */

const API_URL =
  typeof window === 'undefined'
    ? (process.env.API_URL ?? 'http://localhost:4000')
    : (process.env.NEXT_PUBLIC_API_URL ?? '');

export interface ApiError {
  message: string;
  issues?: Array<{ path: string; message: string; code: string }>;
  status: number;
}

export class ApiHttpError extends Error implements ApiError {
  status: number;
  issues?: ApiError['issues'];
  constructor(payload: ApiError) {
    super(payload.message);
    this.status = payload.status;
    this.issues = payload.issues;
    this.name = 'ApiHttpError';
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  bearer?: string,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new ApiHttpError({
      message: typeof payload.message === 'string' ? payload.message : response.statusText,
      issues: Array.isArray(payload.issues) ? (payload.issues as ApiError['issues']) : undefined,
      status: response.status,
    });
  }

  return body as T;
}
