import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

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

export const certificatesApi = {
  async listMine(): Promise<Certificate[]> {
    return apiFetch<Certificate[]>('/api/v1/modules/certificates/me', { method: 'GET' }, bearer());
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
