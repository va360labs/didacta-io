import { describe, expect, it } from 'vitest';
import { createThrottle } from '../sync-enrollments-from-learndash.js';

describe('createThrottle (token bucket)', () => {
  it('los primeros N takes (N = capacity = ceil(rate)) no esperan', async () => {
    let nowMs = 1_000_000;
    const sleepsMs: number[] = [];
    const t = createThrottle({
      ratePerSec: 5,
      now: () => nowMs,
      sleep: async (ms) => {
        sleepsMs.push(ms);
        nowMs += ms;
      },
    });
    for (let i = 0; i < 5; i += 1) {
      await t.take();
    }
    expect(sleepsMs).toEqual([]);
  });

  it('cuando se agota la capacity, el siguiente take espera ~1/rate segundos', async () => {
    let nowMs = 2_000_000;
    const sleepsMs: number[] = [];
    const t = createThrottle({
      ratePerSec: 2, // capacity = 2
      now: () => nowMs,
      sleep: async (ms) => {
        sleepsMs.push(ms);
        nowMs += ms;
      },
    });
    await t.take();
    await t.take();
    // El 3er take debe dormir ~500ms (1 token / 2 rps).
    await t.take();
    expect(sleepsMs.length).toBe(1);
    expect(sleepsMs[0]).toBeGreaterThanOrEqual(400);
    expect(sleepsMs[0]).toBeLessThanOrEqual(600);
  });

  it('si pasa tiempo entre takes, los tokens se rellenan sin dormir', async () => {
    let nowMs = 3_000_000;
    const sleepsMs: number[] = [];
    const t = createThrottle({
      ratePerSec: 4,
      now: () => nowMs,
      sleep: async (ms) => {
        sleepsMs.push(ms);
        nowMs += ms;
      },
    });
    // Consumir la capacity (4).
    for (let i = 0; i < 4; i += 1) await t.take();
    // Avanzar 1 segundo simulado → 4 tokens rellenados.
    nowMs += 1000;
    for (let i = 0; i < 4; i += 1) await t.take();
    expect(sleepsMs).toEqual([]);
  });

  it('rate inválido (0 o negativo) se clampa al mínimo seguro', async () => {
    let nowMs = 0;
    const sleepsMs: number[] = [];
    const t = createThrottle({
      ratePerSec: 0,
      now: () => nowMs,
      sleep: async (ms) => {
        sleepsMs.push(ms);
        nowMs += ms;
      },
    });
    // Capacity es al menos 1 → el primer take no duerme.
    await t.take();
    expect(sleepsMs).toEqual([]);
  });
});
