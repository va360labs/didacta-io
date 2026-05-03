/**
 * Cliente HTTP del wizard. Habla con el backend a través de los
 * endpoints del módulo. Asume que el host inyecta una baseUrl + token.
 */
import type {
  ImportOptionsDto,
  JobReportDto,
  PreflightResultDto,
  ProgressEventDto,
  SourceCredentialsDto,
} from '../../src/dto.js';

export interface ApiClientOptions {
  baseUrl: string;
  getAuthToken(): Promise<string>;
}

export class MigratorApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.opts.getAuthToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async preflight(credentials: SourceCredentialsDto): Promise<PreflightResultDto> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/modules/migrator-learndash/preflight`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ credentials }),
    });
    if (!res.ok) throw await asError(res);
    return res.json();
  }

  async startJob(credentials: SourceCredentialsDto, options: ImportOptionsDto): Promise<{ jobId: string }> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/modules/migrator-learndash/jobs`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ credentials, options }),
    });
    if (!res.ok) throw await asError(res);
    return res.json();
  }

  async getJob(jobId: string): Promise<unknown> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/modules/migrator-learndash/jobs/${jobId}`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw await asError(res);
    return res.json();
  }

  async cancelJob(jobId: string): Promise<void> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/modules/migrator-learndash/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw await asError(res);
  }

  async getReport(jobId: string): Promise<JobReportDto> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/modules/migrator-learndash/jobs/${jobId}/report`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw await asError(res);
    return res.json();
  }

  /** Conecta a SSE y emite eventos de progreso. Devuelve un disposer. */
  subscribeProgress(jobId: string, onEvent: (event: ProgressEventDto) => void, onError?: (err: Error) => void): () => void {
    const es = new EventSource(
      `${this.opts.baseUrl}/api/v1/modules/migrator-learndash/jobs/${jobId}/progress`,
      { withCredentials: true },
    );
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as ProgressEventDto);
      } catch (err) {
        onError?.(err as Error);
      }
    };
    es.onerror = () => onError?.(new Error('connection lost'));
    return () => es.close();
  }
}

async function asError(res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  const code = (body && typeof body === 'object' && 'code' in body && (body as Record<string, unknown>)['code']) as
    | string
    | undefined;
  const message =
    (body && typeof body === 'object' && 'message' in body && (body as Record<string, unknown>)['message']) ||
    res.statusText;
  const err = new Error(String(message ?? 'unknown error'));
  (err as Error & { status?: number; code?: string }).status = res.status;
  (err as Error & { status?: number; code?: string }).code = code;
  return err;
}
