import { Subject, type Observable } from 'rxjs';
import type { ProgressEventDto } from '../dto.js';

/**
 * Bus de progreso por jobId. Múltiples suscriptores (SSE clients) leen del
 * mismo Subject. El progreso también se persiste en BD periódicamente
 * (responsabilidad del orquestador).
 */
export class ProgressBus {
  private readonly subjects = new Map<string, Subject<ProgressEventDto>>();

  emit(jobId: string, event: ProgressEventDto): void {
    const s = this.getOrCreate(jobId);
    s.next(event);
  }

  observe(jobId: string): Observable<ProgressEventDto> {
    return this.getOrCreate(jobId).asObservable();
  }

  complete(jobId: string): void {
    const s = this.subjects.get(jobId);
    if (s) {
      s.complete();
      this.subjects.delete(jobId);
    }
  }

  private getOrCreate(jobId: string): Subject<ProgressEventDto> {
    let s = this.subjects.get(jobId);
    if (!s) {
      s = new Subject<ProgressEventDto>();
      this.subjects.set(jobId, s);
    }
    return s;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
