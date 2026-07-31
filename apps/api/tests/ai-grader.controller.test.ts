import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiGraderController } from '../src/modules/ai-grader/ai-grader.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller de AI Grader (LMS-91.C).
 *
 * Verifican:
 *   - guards de rol formador/admin en TODAS las rutas.
 *   - aislamiento por tenantId del JWT (nunca confiar en parámetros).
 *   - delegación correcta a rubricService / suggestionService.
 *   - userId del JWT propaga a markApplied (auditoría).
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'formador-1',
    tenantId: 'tenant-A',
    roles: ['formador'],
    email: 'f@x.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeRegistry() {
  const rubric = {
    get: vi.fn(async () => null),
    upsert: vi.fn(async () => ({ id: 'r1' })),
    remove: vi.fn(async () => ({ deleted: true })),
  };
  const suggestion = {
    suggestForAttempt: vi.fn(async () => ({
      attemptId: 'att-1',
      generated: [],
      skipped: [],
      tokensUsed: { input: 0, output: 0 },
      durationMs: 0,
    })),
    listForAttempt: vi.fn(async () => []),
    markApplied: vi.fn(async () => ({ id: 'sug-1', applied: true })),
  };
  return {
    registry: {
      getAiGraderRubricService: () => rubric,
      getAiGraderSuggestionService: () => suggestion,
    } as unknown as ModuleRegistryService,
    spies: { rubric, suggestion },
  };
}

describe('AiGraderController · guards', () => {
  it('rechaza sin sesión', async () => {
    const { registry } = makeRegistry();
    const c = new AiGraderController(registry);
    await expect(c.getRubric(undefined, 'q1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza alumno', async () => {
    const { registry } = makeRegistry();
    const c = new AiGraderController(registry);
    await expect(c.getRubric(makeUser({ roles: ['alumno'] }), 'q1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each(['tenant_admin', 'super_admin', 'formador'] as const)(
    'rol %s pasa el guard',
    async (role) => {
      const { registry } = makeRegistry();
      const c = new AiGraderController(registry);
      await expect(c.getRubric(makeUser({ roles: [role] }), 'q1')).resolves.toBeNull();
    },
  );
});

describe('AiGraderController · rúbricas', () => {
  it('upsert pasa tenantId del JWT y body al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiGraderController(registry);
    const dto = { instructions: 'x', criteria: [{ name: 'A', description: 'd', weight: 5 }] };
    await c.upsertRubric(makeUser({ tenantId: 'tenant-X' }), 'q-42', dto as never);
    expect(spies.rubric.upsert).toHaveBeenCalledWith('tenant-X', 'q-42', dto);
  });

  it('remove llama deleteMany con tenantId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiGraderController(registry);
    await c.removeRubric(makeUser({ tenantId: 'tenant-Y' }), 'q-1');
    expect(spies.rubric.remove).toHaveBeenCalledWith('tenant-Y', 'q-1');
  });
});

describe('AiGraderController · sugerencias', () => {
  it('suggest pasa tenantId + dto al service', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiGraderController(registry);
    await c.suggest(makeUser({ tenantId: 'tenant-A' }), 'att-9', { force: true } as never);
    expect(spies.suggestion.suggestForAttempt).toHaveBeenCalledWith('tenant-A', 'att-9', {
      force: true,
    });
  });

  it('listSuggestions filtra por tenantId del JWT', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiGraderController(registry);
    await c.listSuggestions(makeUser({ tenantId: 'tenant-Z' }), 'att-7');
    expect(spies.suggestion.listForAttempt).toHaveBeenCalledWith('tenant-Z', 'att-7');
  });

  it('markApplied registra el userId del JWT como appliedById', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiGraderController(registry);
    await c.markApplied(makeUser({ sub: 'real-user' }), 'sug-99');
    expect(spies.suggestion.markApplied).toHaveBeenCalledWith('tenant-A', 'sug-99', 'real-user');
  });
});
