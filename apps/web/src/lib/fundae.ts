import { apiFetch, ApiHttpError } from './api-client';
import { authStorage } from './auth-storage';

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

  /**
   * Devuelve la URL del XML para descarga (con auth bearer en query como
   * fallback, por si no se puede usar header). Lo más simple: el browser
   * navega y descarga.
   */
  exportXmlUrl(id: string): string {
    return `/api/v1/modules/fundae/actions/${id}/export.xml`;
  },
};
