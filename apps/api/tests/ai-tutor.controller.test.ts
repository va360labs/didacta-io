import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiTutorController } from '../src/modules/ai-tutor/ai-tutor.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Tests del controller del tutor IA (LMS-90.E).
 *
 * Verifican:
 *   - guard de auth para `ask` (cualquier usuario logueado).
 *   - guard de admin para `reindex`.
 *   - delegación correcta al chat service / indexer pasando tenantId
 *     y userId del JWT (nunca confiar en parámetros del cliente).
 *   - 401 si el módulo ai-tutor no está activo en el tenant.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    email: 'a@x.com',
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeRegistry(opts: { indexerEnabled?: boolean } = {}) {
  const ask = vi.fn(async () => ({
    answer: 'respuesta',
    citations: [],
    conversationId: 'conv-1',
    tokensUsed: { input: 10, output: 5 },
  }));
  const indexCourse = vi.fn(async () => ({
    courseId: 'c1',
    lessonsProcessed: 3,
    chunksGenerated: 10,
    tokensUsed: 200,
    durationMs: 500,
  }));
  const chat = { ask };
  const indexer = { indexCourse };
  return {
    registry: {
      getAiTutorChatService: () => chat,
      getAiTutorIndexerServiceOrNull: () => (opts.indexerEnabled === false ? null : indexer),
    } as unknown as ModuleRegistryService,
    spies: { ask, indexCourse },
  };
}

describe('AiTutorController · ask', () => {
  it('rechaza sin sesión', async () => {
    const { registry } = makeRegistry();
    const c = new AiTutorController(registry);
    await expect(
      c.ask(undefined, 'course-1', { question: 'hola?' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un alumno pregunta como alumno: se le comprueba matrícula y cuota', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiTutorController(registry);
    await c.ask(makeUser({ roles: ['alumno'] }), 'course-1', {
      question: 'que es algo?',
    } as never);
    expect(spies.ask).toHaveBeenCalledWith(
      'tenant-A',
      'user-1',
      'course-1',
      { question: 'que es algo?' },
      { staff: false },
    );
  });

  it('pasa tenantId y userId del JWT al service (no del request)', async () => {
    const { registry, spies } = makeRegistry();
    const c = new AiTutorController(registry);
    await c.ask(makeUser({ sub: 'real-user', tenantId: 'real-tenant' }), 'course-X', {
      question: 'q?',
      conversationId: 'conv-existing',
    } as never);
    expect(spies.ask).toHaveBeenCalledWith(
      'real-tenant',
      'real-user',
      'course-X',
      { question: 'q?', conversationId: 'conv-existing' },
      { staff: false },
    );
  });

  // El formador prueba el tutor de un curso que no ha comprado, y sus pruebas
  // no consumen la cuota diaria de nadie.
  it.each([['formador'], ['tenant_admin'], ['super_admin']])(
    '%s pregunta como staff (sin matrícula ni cuota)',
    async (rol) => {
      const { registry, spies } = makeRegistry();
      const c = new AiTutorController(registry);
      await c.ask(makeUser({ roles: [rol] }), 'course-1', { question: 'q?' } as never);
      expect(spies.ask).toHaveBeenCalledWith(
        'tenant-A',
        'user-1',
        'course-1',
        { question: 'q?' },
        {
          staff: true,
        },
      );
    },
  );
});

describe('AiTutorController · reindex', () => {
  it('rechaza sin sesión', async () => {
    const { registry } = makeRegistry();
    const c = new AiTutorController(registry);
    await expect(c.reindex(undefined, 'c1', {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza alumno', async () => {
    const { registry } = makeRegistry();
    const c = new AiTutorController(registry);
    await expect(
      c.reindex(makeUser({ roles: ['alumno'] }), 'c1', {} as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza formador', async () => {
    const { registry } = makeRegistry();
    const c = new AiTutorController(registry);
    await expect(
      c.reindex(makeUser({ roles: ['formador'] }), 'c1', {} as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(['tenant_admin', 'super_admin'] as const)('rol %s pasa el guard', async (role) => {
    const { registry, spies } = makeRegistry();
    const c = new AiTutorController(registry);
    await c.reindex(makeUser({ roles: [role] }), 'c1', { force: true } as never);
    expect(spies.indexCourse).toHaveBeenCalledWith('tenant-A', 'c1', { force: true });
  });

  it('si el módulo ai-tutor no está activo, lanza UnauthorizedException', async () => {
    const { registry } = makeRegistry({ indexerEnabled: false });
    const c = new AiTutorController(registry);
    await expect(
      c.reindex(makeUser({ roles: ['tenant_admin'] }), 'c1', {} as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
