import { describe, expect, it } from 'vitest';
import {
  BlockedDidactaApi,
  DIDACTA_EXTERNAL_ID_REGEX,
  DIDACTA_EXTERNAL_SOURCE_REGEX,
  DIDACTA_PERMISSIONS,
  DidactaError,
  NoopDidactaApi,
} from '../../src/marketplace/sandboxed-didacta.types';

/// Tests de los stubs del contrato `ctx.didacta` (DD-001).
///
/// `BlockedDidactaApi` se inyecta a módulos que NO declaran el bloque
/// `didacta` en su manifest. Cualquier llamada debe rechazarse con
/// `DIDACTA_PERMISSION_DENIED` y mensaje accionable que diga al dev
/// exactamente qué añadir al manifest.
///
/// `NoopDidactaApi` es para tests del dispatcher (placeholder histórico).
/// Cualquier llamada lanza `DIDACTA_INTERNAL_ERROR` con mensaje de "esto
/// solo debería ocurrir en tests".
///
/// Los regex de identificadores (`DIDACTA_EXTERNAL_SOURCE_REGEX`,
/// `DIDACTA_EXTERNAL_ID_REGEX`) deben aceptar exactamente lo declarado en
/// los comentarios del archivo de tipos — no mover los rangos sin revisar
/// el contrato público.

describe('BlockedDidactaApi', () => {
  const blocked = new BlockedDidactaApi('mod.example');

  it('users.upsertByExternalRef rechaza con DIDACTA_PERMISSION_DENIED', async () => {
    await expect(
      blocked.users.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      name: 'DidactaError',
      code: 'DIDACTA_PERMISSION_DENIED',
    });
  });

  it('courses.create rechaza con DIDACTA_PERMISSION_DENIED', async () => {
    await expect(blocked.courses.create({ slug: 'foo', title: 'Foo' })).rejects.toMatchObject({
      code: 'DIDACTA_PERMISSION_DENIED',
    });
  });

  it('cualquier método rechaza, no solo los upsert', async () => {
    await expect(
      blocked.courses.findByExternalRef({ externalSource: 'x', externalId: '1' }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });

    await expect(
      blocked.courses.deleteByExternalRef({ externalSource: 'x', externalId: '1' }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });

    await expect(blocked.courses.publish('uuid')).rejects.toMatchObject({
      code: 'DIDACTA_PERMISSION_DENIED',
    });
  });

  it('mensaje accionable: menciona el moduleName y el método invocado', async () => {
    try {
      await blocked.lessons.upsertByExternalRef({
        externalSource: 'learndash',
        externalId: '99',
        moduleExternalRef: { externalSource: 'learndash', externalId: '1' },
        type: 'TEXT',
        title: 'Lesson',
        position: 1,
        content: {},
      });
      expect.fail('debería haber rechazado');
    } catch (err) {
      expect(err).toBeInstanceOf(DidactaError);
      const msg = (err as DidactaError).message;
      expect(msg).toContain('mod.example');
      expect(msg).toContain('lessons.upsertByExternalRef');
      // Debe explicar QUÉ añadir al manifest, no solo que falló
      expect(msg).toContain('didacta');
      expect(msg).toContain('manifest');
      expect(msg).toContain('externalSource');
      expect(msg).toContain('permissions');
    }
  });

  it('todos los recursos del API responden con error tipado (cobertura completa)', async () => {
    const recurso = { externalSource: 'x', externalId: '1' };
    await expect(blocked.users.findByExternalRef(recurso)).rejects.toMatchObject({
      code: 'DIDACTA_PERMISSION_DENIED',
    });
    await expect(
      blocked.courseModules.upsertByExternalRef({
        ...recurso,
        courseExternalRef: recurso,
        title: 'Sec',
        position: 1,
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
    await expect(
      blocked.quizzes.upsertByExternalRef({
        ...recurso,
        title: 'Q',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
    await expect(
      blocked.enrollments.upsertByExternalRef({
        ...recurso,
        userExternalRef: recurso,
        courseExternalRef: recurso,
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
    await expect(
      blocked.media.uploadFromUrl({
        url: 'https://x.com/a.png',
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
    await expect(
      blocked.media.uploadFromBytes({
        bytes: new Uint8Array(0),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'DIDACTA_PERMISSION_DENIED' });
  });
});

describe('NoopDidactaApi', () => {
  const noop = new NoopDidactaApi();

  it('cualquier llamada lanza DIDACTA_INTERNAL_ERROR con mensaje de tests', async () => {
    await expect(
      noop.users.upsertByExternalRef({
        externalSource: 'x',
        externalId: '1',
        email: 'a@b.com',
      }),
    ).rejects.toMatchObject({
      name: 'DidactaError',
      code: 'DIDACTA_INTERNAL_ERROR',
    });

    try {
      await noop.courses.create({ slug: 'a', title: 'A' });
      expect.fail();
    } catch (err) {
      expect((err as DidactaError).message).toContain('NoopDidactaApi');
      expect((err as DidactaError).message).toContain('tests');
    }
  });
});

describe('DIDACTA_EXTERNAL_SOURCE_REGEX', () => {
  it.each([
    ['learndash', true],
    ['moodle', true],
    ['learn-dash', true],
    ['learn_dash', true],
    ['l', true],
    ['a'.repeat(40), true],
    ['a'.repeat(41), false], // > 40 chars
    ['', false],
    ['LearnDash', false], // mayúsculas
    ['learn dash', false], // espacio
    ['learn.dash', false], // punto
    ['-learn', false], // empieza con guión
    ['_learn', false], // empieza con _
  ])('source %j → válido: %s', (source, expected) => {
    expect(DIDACTA_EXTERNAL_SOURCE_REGEX.test(source)).toBe(expected);
  });
});

describe('DIDACTA_EXTERNAL_ID_REGEX', () => {
  it.each([
    ['1', true],
    ['12345', true],
    ['abc-123_xyz.foo', true],
    ['UUID-123:something', true],
    ['a'.repeat(200), true],
    ['a'.repeat(201), false], // > 200 chars
    ['', false],
    ['has space', false],
    ['quote"foo', false],
    ['back\\slash', false],
  ])('externalId %j → válido: %s', (id, expected) => {
    expect(DIDACTA_EXTERNAL_ID_REGEX.test(id)).toBe(expected);
  });
});

describe('DIDACTA_PERMISSIONS', () => {
  it('contiene los permisos esperados de Sprint 2 (cierre de contrato)', () => {
    // Sanity check: si alguien añade o quita un permiso, este test falla
    // y obliga a actualizar el contrato + bumpar @didacta/module-package-spec.
    expect(DIDACTA_PERMISSIONS).toContain('users.upsertByExternalRef');
    expect(DIDACTA_PERMISSIONS).toContain('courses.create');
    expect(DIDACTA_PERMISSIONS).toContain('courses.publish');
    expect(DIDACTA_PERMISSIONS).toContain('courses.deleteByExternalRef');
    expect(DIDACTA_PERMISSIONS).toContain('lessons.upsertByExternalRef');
    expect(DIDACTA_PERMISSIONS).toContain('quizzes.upsertByExternalRef');
    expect(DIDACTA_PERMISSIONS).toContain('enrollments.upsertByExternalRef');
    expect(DIDACTA_PERMISSIONS).toContain('media.uploadFromUrl');
    expect(DIDACTA_PERMISSIONS).toContain('media.uploadFromBytes');
  });

  it('todos los permisos siguen el patrón "<recurso>.<acción>"', () => {
    for (const perm of DIDACTA_PERMISSIONS) {
      expect(perm).toMatch(/^[a-z][a-zA-Z]*\.[a-zA-Z]+$/);
    }
  });

  it('no hay permisos duplicados', () => {
    const set = new Set(DIDACTA_PERMISSIONS);
    expect(set.size).toBe(DIDACTA_PERMISSIONS.length);
  });
});
