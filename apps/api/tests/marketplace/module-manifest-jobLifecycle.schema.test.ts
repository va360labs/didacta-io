import { describe, expect, it } from 'vitest';
import { moduleManifestSchema } from '../../src/marketplace/module-manifest.schema';

/// Tests del bloque `jobLifecycle` añadido al manifest en Sprint 3 / JR-003.
///
/// El bloque declara qué función del bundle el worker invoca por cada tick.
/// Si está ausente, el módulo no participa del runtime de jobs (es 100%
/// síncrono). Si está, el sandbox valida que el bundle exporte la función
/// referenciada — si no, install falla con MODULE_BOOT_FAILED.

const baseManifest = {
  name: 'mod.example',
  version: '1.0.0',
  displayName: 'Example',
  coreVersionRequired: '^0.0.0',
  tablePrefix: 'mod_example_',
  apiNamespace: '/modules/example',
  vendor: 'didacta' as const,
};

describe('moduleManifestSchema — bloque jobLifecycle (Sprint 3)', () => {
  it('manifest sin bloque jobLifecycle es válido (módulos puramente síncronos)', () => {
    const result = moduleManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('jobLifecycle válido con identifier JS estándar es aceptado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: 'onJobTick' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobLifecycle?.onTickFn).toBe('onJobTick');
    }
  });

  it('jobLifecycle con maxTicksPerHour custom es aceptado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: 'tick', maxTicksPerHour: 1200 },
    });
    expect(result.success).toBe(true);
  });

  it('jobLifecycle con onTickFn vacío es rechazado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: '' },
    });
    expect(result.success).toBe(false);
  });

  it('jobLifecycle con onTickFn que no es identifier JS es rechazado', () => {
    // Espacios, guiones medios, caracteres especiales — todos deben fallar.
    const samples = ['has-dash', 'has space', '123starts', 'has.dot', 'has-special!'];
    for (const fn of samples) {
      const result = moduleManifestSchema.safeParse({
        ...baseManifest,
        jobLifecycle: { onTickFn: fn },
      });
      expect(result.success, `expected to reject "${fn}"`).toBe(false);
    }
  });

  it('jobLifecycle con onTickFn empezando en underscore es aceptado (identifier válido)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: '_handler' },
    });
    expect(result.success).toBe(true);
  });

  it('jobLifecycle con maxTicksPerHour mayor al cap (3600) es rechazado', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: 'tick', maxTicksPerHour: 5000 },
    });
    expect(result.success).toBe(false);
  });

  it('jobLifecycle con campos extra es rechazado (.strict)', () => {
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: 'tick', unknownField: 'oops' } as never,
    });
    expect(result.success).toBe(false);
  });

  it('jobLifecycle con onTickFn > 60 chars es rechazado', () => {
    const long = 'a'.repeat(61);
    const result = moduleManifestSchema.safeParse({
      ...baseManifest,
      jobLifecycle: { onTickFn: long },
    });
    expect(result.success).toBe(false);
  });
});
