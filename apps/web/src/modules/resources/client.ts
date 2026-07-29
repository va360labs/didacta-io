import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/** Cliente HTTP de mod.resources (bloque 4 — biblioteca de recursos). */

const BASE = '/api/v1/modules/resources';

export type ResourceCategory = 'WORKFLOW' | 'SKILL' | 'TOOL' | 'TEMPLATE' | 'OTHER';
export type ResourceKind = 'FILE' | 'LINK';

export const RESOURCE_CATEGORY_LABELS: Record<ResourceCategory, string> = {
  WORKFLOW: 'Workflows',
  SKILL: 'Skills',
  TOOL: 'Herramientas IA',
  TEMPLATE: 'Plantillas',
  OTHER: 'Otros',
};

export interface ResourceView {
  id: string;
  category: ResourceCategory;
  kind: ResourceKind;
  title: string;
  description: string | null;
  url: string;
  fileName: string | null;
  downloadCount: number;
  createdAt: string;
}

export interface CreateResourceInput {
  category: ResourceCategory;
  kind: ResourceKind;
  title: string;
  description?: string;
  url: string;
  fileName?: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const resourcesApi = {
  async list(filter: { category?: ResourceCategory; q?: string } = {}): Promise<ResourceView[]> {
    const params = new URLSearchParams();
    if (filter.category) params.set('category', filter.category);
    if (filter.q) params.set('q', filter.q);
    const qs = params.toString();
    const res = await apiFetch<{ resources: ResourceView[] }>(
      `${BASE}${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
    return res.resources;
  },

  async create(input: CreateResourceInput): Promise<ResourceView> {
    return apiFetch<ResourceView>(
      BASE,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  /** Registra la descarga/apertura y devuelve la URL a abrir. */
  async download(id: string): Promise<{ url: string }> {
    return apiFetch<{ url: string }>(`${BASE}/${id}/download`, { method: 'POST' }, withAuth());
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`${BASE}/${id}`, { method: 'DELETE' }, withAuth());
  },
};
