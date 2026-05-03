export interface RetryPolicy {
  shouldRetry(attempt: number, error: unknown, response?: Response): boolean;
  delayMs(attempt: number, response?: Response): number;
}

const MAX_ATTEMPTS = 5;

export const defaultRetry: RetryPolicy = {
  shouldRetry(attempt, error, response) {
    if (attempt >= MAX_ATTEMPTS) return false;
    if (response?.status === 429) return true;
    if (response && response.status >= 500 && response.status < 600) return true;
    if (error instanceof TypeError) return true;
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    return false;
  },
  delayMs(attempt, response) {
    const ra = response?.headers.get('retry-after');
    if (ra) {
      const seconds = Number(ra);
      if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 60_000);
    }
    const base = Math.min(2 ** attempt * 250, 30_000);
    return Math.floor(Math.random() * base);
  },
};
