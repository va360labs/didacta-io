import { apiFetch, ApiHttpError } from './api-client';
import { authStorage } from './auth-storage';

/**
 * Cliente HTTP de empresas bonificadas Fundae (LMS-79). Espeja el contrato
 * del controller `FundaeCompaniesController` bajo `/api/v1/admin/fundae/companies`.
 */

export interface DatosContacto {
  direccion?: string;
  ciudad?: string;
  codigoPostal?: string;
  provincia?: string;
  pais?: string;
  contactoNombre?: string;
  contactoEmail?: string;
  contactoTelefono?: string;
}

export interface FundaeCompany {
  id: string;
  tenantId: string;
  nif: string;
  razonSocial: string;
  cccPrincipal: string | null;
  plantilla: number | null;
  creditoTotalCents: number | null;
  creditoUsadoCents: number;
  creditoDisponibleCents: number | null;
  datosContacto: DatosContacto;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateCompanyInput {
  nif: string;
  razonSocial: string;
  cccPrincipal?: string;
  plantilla?: number;
  creditoTotalCents?: number;
  datosContacto?: DatosContacto;
  notas?: string;
}

export interface UpdateCompanyInput {
  razonSocial?: string;
  cccPrincipal?: string | null;
  plantilla?: number | null;
  creditoTotalCents?: number | null;
  datosContacto?: DatosContacto;
  notas?: string | null;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const fundaeCompaniesApi = {
  async list(opts: { search?: string; includeDeleted?: boolean } = {}): Promise<FundaeCompany[]> {
    const params = new URLSearchParams();
    if (opts.search) params.set('search', opts.search);
    if (opts.includeDeleted) params.set('includeDeleted', 'true');
    const qs = params.toString();
    return apiFetch<FundaeCompany[]>(
      `/api/v1/admin/fundae/companies${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async get(id: string): Promise<FundaeCompany> {
    return apiFetch<FundaeCompany>(
      `/api/v1/admin/fundae/companies/${id}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async create(input: CreateCompanyInput): Promise<FundaeCompany> {
    return apiFetch<FundaeCompany>(
      '/api/v1/admin/fundae/companies',
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async update(id: string, input: UpdateCompanyInput): Promise<FundaeCompany> {
    return apiFetch<FundaeCompany>(
      `/api/v1/admin/fundae/companies/${id}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async remove(id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/fundae/companies/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};

/** Formatea céntimos como "12.345,67 €" (locale es-ES). */
export function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// -------------------- Notificaciones RLPT (LMS-80) --------------------

export type RlptNoticeType = 'NOTIFICACION_INICIAL' | 'ACUSE_RECIBO' | 'ACTA_DISCREPANCIA';

export interface RlptNotice {
  id: string;
  tenantId: string;
  companyId: string;
  tipo: RlptNoticeType;
  fechaNotificacionAt: string;
  plazoVencimientoAt: string;
  evidenceEntryId: string;
  evidenceHash: string;
  evidenceSize: number;
  observaciones: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface UploadRlptInput {
  tipo: RlptNoticeType;
  fechaNotificacionAt?: string;
  plazoVencimientoAt?: string;
  observaciones?: string;
  /** Documento base64 (sin prefijo `data:...,`). */
  data: string;
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
  filename?: string;
}

export const fundaeRlptApi = {
  async list(companyId: string): Promise<RlptNotice[]> {
    return apiFetch<RlptNotice[]>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async upload(companyId: string, input: UploadRlptInput): Promise<RlptNotice> {
    return apiFetch<RlptNotice>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async remove(companyId: string, id: string): Promise<void> {
    await apiFetch<{ deleted: true }>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices/${id}`,
      { method: 'DELETE' },
      withAuth(),
    );
  },
};

/** Lee un File como base64 sin el prefijo `data:`. */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('No pudimos leer el archivo.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Resultado inesperado del FileReader.'));
        return;
      }
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
