import { apiFetch, ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export type Modalidad = 'PRESENCIAL' | 'TELEFORMACION' | 'MIXTA';
export type ActionStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';

export interface FundaeAction {
  id: string;
  tenantId: string;
  courseId: string | null;
  codigoAccion: string;
  nombre: string;
  modalidad: Modalidad;
  horasFormacion: number;
  fechaInicio: string;
  fechaFin: string;
  lugar: string | null;
  cifCentro: string | null;
  notas: string | null;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FundaeBlock {
  id: string;
  actionId: string;
  ordinal: number;
  title: string;
  hours: number;
  modalidad: Modalidad;
  contenidos: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBlockInput {
  ordinal?: number;
  title: string;
  hours: number;
  modalidad: Modalidad;
  contenidos?: string;
}

export interface UpdateBlockInput {
  ordinal?: number;
  title?: string;
  hours?: number;
  modalidad?: Modalidad;
  contenidos?: string;
}

export interface FundaeParticipant {
  userId: string;
  name: string | null;
  email: string;
  documentId: string | null;
  progressPercent: number;
  enrolledAt: string;
  completedAt: string | null;
  status: 'APTO' | 'NO_APTO' | 'EN_CURSO';
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const fundaeApi = {
  async list(opts: { courseId?: string; status?: ActionStatus } = {}): Promise<FundaeAction[]> {
    const params = new URLSearchParams();
    if (opts.courseId) params.set('courseId', opts.courseId);
    if (opts.status) params.set('status', opts.status);
    const qs = params.toString();
    return apiFetch<FundaeAction[]>(
      `/api/v1/modules/fundae/actions${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async create(input: {
    codigoAccion: string;
    nombre: string;
    modalidad: Modalidad;
    horasFormacion: number;
    fechaInicio: string;
    fechaFin: string;
    lugar?: string;
    cifCentro?: string;
    notas?: string;
    courseId?: string | null;
  }): Promise<FundaeAction> {
    return apiFetch<FundaeAction>(
      '/api/v1/modules/fundae/actions',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async archive(id: string): Promise<void> {
    await apiFetch<{ archived: true }>(
      `/api/v1/modules/fundae/actions/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },

  async countParticipants(id: string): Promise<{ total: number }> {
    return apiFetch<{ total: number }>(
      `/api/v1/modules/fundae/actions/${id}/participants/count`,
      { method: 'GET' },
      withAuth(),
    );
  },

  /**
   * Devuelve la URL del XML para descarga (con auth bearer en query como
   * fallback, por si no se puede usar header). Lo más simple: el browser
   * navega y descarga.
   */
  exportXmlUrl(id: string): string {
    return `/api/v1/modules/fundae/actions/${id}/export.xml`;
  },

  exportZipUrl(id: string): string {
    return `/api/v1/modules/fundae/actions/${id}/export.zip`;
  },

  evidencePdfUrl(actionId: string, userId: string): string {
    return `/api/v1/modules/fundae/actions/${actionId}/participants/${userId}/evidence.pdf`;
  },

  async listParticipants(actionId: string): Promise<FundaeParticipant[]> {
    return apiFetch<FundaeParticipant[]>(
      `/api/v1/modules/fundae/actions/${actionId}/participants`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async get(id: string): Promise<FundaeAction> {
    return apiFetch<FundaeAction>(
      `/api/v1/modules/fundae/actions/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async listBlocks(actionId: string): Promise<FundaeBlock[]> {
    return apiFetch<FundaeBlock[]>(
      `/api/v1/modules/fundae/actions/${actionId}/blocks`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async createBlock(actionId: string, input: CreateBlockInput): Promise<FundaeBlock> {
    return apiFetch<FundaeBlock>(
      `/api/v1/modules/fundae/actions/${actionId}/blocks`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateBlock(
    actionId: string,
    blockId: string,
    input: UpdateBlockInput,
  ): Promise<FundaeBlock> {
    return apiFetch<FundaeBlock>(
      `/api/v1/modules/fundae/actions/${actionId}/blocks/${blockId}`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async deleteBlock(actionId: string, blockId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/modules/fundae/actions/${actionId}/blocks/${blockId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};
