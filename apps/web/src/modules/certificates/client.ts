import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

export interface Certificate {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  enrollmentId: string;
  templateId: string | null;
  number: string;
  hash: string;
  snapshot: {
    studentName?: string;
    courseTitle?: string;
    issuedAt?: string;
  } | null;
  storageKey: string;
  size: number;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

function bearer(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export interface CertificateTemplate {
  id: string;
  tenantId: string;
  name: string;
  body: string;
  primaryColor: string;
  logoUrl: string | null;
  signerName: string | null;
  signerTitle: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateTemplateInput {
  name: string;
  body: string;
  primaryColor?: string;
  logoUrl?: string | null;
  signerName?: string | null;
  signerTitle?: string | null;
  isDefault?: boolean;
}

export const certificateTemplatesApi = {
  async list(): Promise<CertificateTemplate[]> {
    return apiFetch<CertificateTemplate[]>(
      '/api/v1/modules/certificates/templates',
      { method: 'GET' },
      bearer(),
    );
  },
  async create(dto: CertificateTemplateInput): Promise<CertificateTemplate> {
    return apiFetch<CertificateTemplate>(
      '/api/v1/modules/certificates/templates',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer(),
    );
  },
  async update(id: string, dto: Partial<CertificateTemplateInput>): Promise<CertificateTemplate> {
    return apiFetch<CertificateTemplate>(
      `/api/v1/modules/certificates/templates/${id}`,
      { method: 'PATCH', body: JSON.stringify(dto) },
      bearer(),
    );
  },
  async setDefault(id: string): Promise<CertificateTemplate> {
    return apiFetch<CertificateTemplate>(
      `/api/v1/modules/certificates/templates/${id}/set-default`,
      { method: 'POST', body: '{}' },
      bearer(),
    );
  },
  async remove(id: string): Promise<{ ok: true }> {
    return apiFetch<{ ok: true }>(
      `/api/v1/modules/certificates/templates/${id}`,
      { method: 'DELETE' },
      bearer(),
    );
  },

  /**
   * Renderiza un PDF preview con los datos del draft sin persistir.
   * Devuelve un Blob (application/pdf) que el caller abre en otra pestaña.
   */
  async preview(input: CertificateTemplateInput): Promise<Blob> {
    const token = bearer();
    const res = await fetch('/api/v1/modules/certificates/templates/preview', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new ApiHttpError({
        message: `No se pudo generar el preview (${res.status})`,
        status: res.status,
      });
    }
    return res.blob();
  },
};

export interface PublicCertificateView {
  number: string;
  studentName: string;
  courseTitle: string;
  issuedAt: string;
  valid: boolean;
}

export const certificatesApi = {
  async listMine(): Promise<Certificate[]> {
    return apiFetch<Certificate[]>('/api/v1/modules/certificates/me', { method: 'GET' }, bearer());
  },

  /**
   * Verificación PÚBLICA de un certificado por su id (sin sesión). Devuelve solo
   * datos no sensibles. La usa la página pública `/verificar/[id]`.
   */
  async verifyPublic(id: string): Promise<PublicCertificateView> {
    return apiFetch<PublicCertificateView>(
      `/api/v1/modules/certificates/verify/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
  },

  async getById(id: string): Promise<Certificate> {
    return apiFetch<Certificate>(`/api/v1/modules/certificates/${id}`, { method: 'GET' }, bearer());
  },

  /**
   * URL para abrir/descargar el PDF.
   * El PDF requiere bearer, así que la abrimos con fetch+blob,
   * no con un <a href> directo (no soporta cabeceras).
   */
  async downloadBlob(id: string): Promise<Blob> {
    const token = bearer();
    const res = await fetch(`/api/v1/modules/certificates/${id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new ApiHttpError({
        message: `No se pudo descargar el certificado (${res.status})`,
        status: res.status,
      });
    }
    return res.blob();
  },

  async openInNewTab(id: string, suggestedName?: string): Promise<void> {
    const blob = await this.downloadBlob(id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    if (suggestedName) link.download = suggestedName;
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
};
