import { apiFetch, ApiHttpError } from './api-client';
import { authStorage } from './auth-storage';

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
  notas: string | null;
  createdAt: string;
  updatedAt: string;
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
