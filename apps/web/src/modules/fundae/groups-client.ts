import { apiFetch, ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Cliente HTTP de grupos bonificables Fundae (LMS-81).
 * Espeja el contrato de `FundaeGroupsController` bajo `/api/v1/admin/fundae/groups`.
 */

export type GroupStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED';
export type CostTipo = 'DIRECTO' | 'INDIRECTO' | 'ORGANIZACION';
export type Modalidad = 'PRESENCIAL' | 'TELEFORMACION' | 'MIXTA';

export interface FundaeGroup {
  id: string;
  tenantId: string;
  actionId: string;
  companyId: string;
  numeroGrupo: number;
  modalidad: Modalidad;
  fechaInicioPrevista: string;
  fechaFinPrevista: string;
  fechaInicioReal: string | null;
  fechaFinReal: string | null;
  status: GroupStatus;
  creditoEstimadoCents: number | null;
  creditoConsumidoCents: number;
  costsByTipo: Record<CostTipo, number>;
  umbralFinalizacionPct: number;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ParticipantResultado = 'APTO' | 'NO_APTO' | 'EN_CURSO';

export interface ParticipantCompletionView {
  participantId: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  nifAlumno: string | null;
  horasAsistidas: number;
  progressPercent: number;
  resultado: ParticipantResultado;
  completedAt: string | null;
}

export interface GroupCompletionResult {
  groupId: string;
  umbralAplicadoPct: number;
  totalParticipantes: number;
  aptos: number;
  noAptos: number;
  enCurso: number;
  preview: boolean;
  participants: ParticipantCompletionView[];
}

export interface FundaeCost {
  id: string;
  tenantId: string;
  groupId: string;
  tipo: CostTipo;
  concepto: string;
  amountCents: number;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupInput {
  actionId: string;
  companyId: string;
  numeroGrupo?: number;
  modalidad: Modalidad;
  fechaInicioPrevista: string;
  fechaFinPrevista: string;
  creditoEstimadoCents?: number;
  notas?: string;
}

export interface UpdateGroupInput {
  modalidad?: Modalidad;
  fechaInicioPrevista?: string;
  fechaFinPrevista?: string;
  creditoEstimadoCents?: number | null;
  notas?: string | null;
}

export interface CreateCostInput {
  tipo: CostTipo;
  concepto: string;
  amountCents: number;
  notas?: string;
}

export interface UpdateCostInput {
  tipo?: CostTipo;
  concepto?: string;
  amountCents?: number;
  notas?: string | null;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

async function downloadXml(path: string): Promise<string> {
  const token = withAuth();
  const res = await fetch(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiHttpError({ message: text || 'No pudimos generar el XML.', status: res.status });
  }
  return res.text();
}

export const fundaeGroupsApi = {
  async list(
    opts: {
      companyId?: string;
      actionId?: string;
      status?: GroupStatus;
    } = {},
  ): Promise<FundaeGroup[]> {
    const params = new URLSearchParams();
    if (opts.companyId) params.set('companyId', opts.companyId);
    if (opts.actionId) params.set('actionId', opts.actionId);
    if (opts.status) params.set('status', opts.status);
    const qs = params.toString();
    return apiFetch<FundaeGroup[]>(
      `/api/v1/admin/fundae/groups${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async get(id: string): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      `/api/v1/admin/fundae/groups/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async create(input: CreateGroupInput): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      '/api/v1/admin/fundae/groups',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async update(id: string, input: UpdateGroupInput): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      `/api/v1/admin/fundae/groups/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async start(id: string): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      `/api/v1/admin/fundae/groups/${id}/start`,
      { method: 'POST' },
      withAuth(),
    );
  },

  async close(id: string): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      `/api/v1/admin/fundae/groups/${id}/close`,
      { method: 'POST' },
      withAuth(),
    );
  },

  async cancel(id: string): Promise<FundaeGroup> {
    return apiFetch<FundaeGroup>(
      `/api/v1/admin/fundae/groups/${id}/cancel`,
      { method: 'POST' },
      withAuth(),
    );
  },

  async finalize(
    id: string,
    opts: { umbralOverride?: number; preview?: boolean } = {},
  ): Promise<GroupCompletionResult> {
    return apiFetch<GroupCompletionResult>(
      `/api/v1/admin/fundae/groups/${id}/finalize`,
      { method: 'POST', body: JSON.stringify(opts) },
      withAuth(),
    );
  },

  /**
   * Devuelve el XML como string. La UI lo descarga creando un Blob.
   * Usa fetch nativo porque `apiFetch` espera JSON.
   */
  async startXml(id: string): Promise<string> {
    return downloadXml(`/api/v1/admin/fundae/groups/${id}/start-xml`);
  },

  /** XML de comunicación de finalización (LMS-85). */
  async endXml(id: string): Promise<string> {
    return downloadXml(`/api/v1/admin/fundae/groups/${id}/end-xml`);
  },

  /** Paquete ZIP de auditoría (LMS-86). Devuelve Blob para descarga directa. */
  async auditZip(id: string): Promise<Blob> {
    const token = withAuth();
    const res = await fetch(`/api/v1/admin/fundae/groups/${id}/audit-zip`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiHttpError({
        message: text || 'No pudimos generar el ZIP de auditoría.',
        status: res.status,
      });
    }
    return res.blob();
  },

  async listCosts(groupId: string): Promise<FundaeCost[]> {
    return apiFetch<FundaeCost[]>(
      `/api/v1/admin/fundae/groups/${groupId}/costs`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async addCost(groupId: string, input: CreateCostInput): Promise<FundaeCost> {
    return apiFetch<FundaeCost>(
      `/api/v1/admin/fundae/groups/${groupId}/costs`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async updateCost(groupId: string, costId: string, input: UpdateCostInput): Promise<FundaeCost> {
    return apiFetch<FundaeCost>(
      `/api/v1/admin/fundae/groups/${groupId}/costs/${costId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async removeCost(groupId: string, costId: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/fundae/groups/${groupId}/costs/${costId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};

export const STATUS_LABELS: Record<GroupStatus, string> = {
  DRAFT: 'Borrador',
  ACTIVE: 'En curso',
  CLOSED: 'Cerrado',
  CANCELLED: 'Cancelado',
};

export const TIPO_LABELS: Record<CostTipo, string> = {
  DIRECTO: 'Directo',
  INDIRECTO: 'Indirecto',
  ORGANIZACION: 'Organización',
};

export const MODALIDAD_LABELS: Record<Modalidad, string> = {
  PRESENCIAL: 'Presencial',
  TELEFORMACION: 'Teleformación',
  MIXTA: 'Mixta',
};

// ──────────────────── Participantes (LMS-82) ────────────────────

export type ParticipantStatus = 'ENROLLED' | 'REMOVED';

export interface FundaeGroupParticipant {
  id: string;
  tenantId: string;
  groupId: string;
  userId: string;
  companyId: string;
  nifAlumno: string | null;
  enrolledAt: string;
  removedAt: string | null;
  status: ParticipantStatus;
  notas: string | null;
  /** Snapshot del cálculo de finalización (LMS-84). */
  horasAsistidas: number | null;
  progressPercent: number | null;
  resultado: ParticipantResultado | null;
  completedAt: string | null;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollParticipantInput {
  userId: string;
  nifAlumno?: string;
  notas?: string;
}

export interface BulkEnrollResult {
  enrolled: number;
  skipped: number;
  total: number;
}

export const fundaeGroupParticipantsApi = {
  async list(
    groupId: string,
    opts: { includeRemoved?: boolean } = {},
  ): Promise<FundaeGroupParticipant[]> {
    const qs = opts.includeRemoved ? '?includeRemoved=true' : '';
    return apiFetch<FundaeGroupParticipant[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants${qs}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async enroll(groupId: string, input: EnrollParticipantInput): Promise<FundaeGroupParticipant> {
    return apiFetch<FundaeGroupParticipant>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async bulkEnroll(groupId: string, sourceCourseId?: string): Promise<BulkEnrollResult> {
    return apiFetch<BulkEnrollResult>(
      `/api/v1/admin/fundae/groups/${groupId}/participants/bulk-enroll`,
      { method: 'POST', body: JSON.stringify({ sourceCourseId }) },
      withAuth(),
    );
  },

  async remove(groupId: string, participantId: string): Promise<void> {
    await apiFetch<{ removed: true }>(
      `/api/v1/admin/fundae/groups/${groupId}/participants/${participantId}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};
