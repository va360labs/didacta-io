/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Token bucket simple. Capacity = rps por defecto.
 * Refill continuo proporcional al tiempo transcurrido.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rps: number,
    private readonly capacity: number = rps,
  ) {
    if (rps <= 0) throw new Error('rps debe ser > 0');
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.rps;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }
  }
}
