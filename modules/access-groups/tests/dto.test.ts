/**
 * Tests de los DTOs Zod del CRUD de grupos y del derivador de slug.
 */

import { describe, expect, it } from 'vitest';
import {
  assignAccessGroupMembersSchema,
  createAccessGroupSchema,
  slugify,
  updateAccessGroupSchema,
} from '../src/dto.js';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('slugify', () => {
  it('normaliza acentos, espacios y mayúsculas', () => {
    expect(slugify('Máster en Producción')).toBe('master-en-produccion');
  });

  it('colapsa símbolos en guiones y recorta extremos', () => {
    expect(slugify('  ¡Grupo!! (Pro) __2026  ')).toBe('grupo-pro-2026');
  });

  it('devuelve cadena vacía si no queda nada usable', () => {
    expect(slugify('¡¡¡···!!!')).toBe('');
  });

  it('trunca a 120 caracteres', () => {
    expect(slugify('a'.repeat(300))).toHaveLength(120);
  });
});

describe('createAccessGroupSchema', () => {
  it('acepta un grupo mínimo válido', () => {
    const parsed = createAccessGroupSchema.parse({ name: 'Pro', kind: 'ALL_COURSES' });
    expect(parsed.kind).toBe('ALL_COURSES');
  });

  it('rechaza kind desconocido y campos extra (strict)', () => {
    expect(() => createAccessGroupSchema.parse({ name: 'X', kind: 'OTRO' })).toThrow();
    expect(() =>
      createAccessGroupSchema.parse({ name: 'X', kind: 'COURSE', extra: true }),
    ).toThrow();
  });

  it('exige slug en minúsculas-kebab y courseIds UUID', () => {
    expect(() =>
      createAccessGroupSchema.parse({ name: 'X', kind: 'COURSE', slug: 'Con Espacios' }),
    ).toThrow();
    expect(() =>
      createAccessGroupSchema.parse({ name: 'X', kind: 'COURSE', courseIds: ['no-uuid'] }),
    ).toThrow();
    const ok = createAccessGroupSchema.parse({ name: 'X', kind: 'COURSE', courseIds: [UUID] });
    expect(ok.courseIds).toEqual([UUID]);
  });
});

describe('updateAccessGroupSchema', () => {
  it('admite linkedTierName string o null (desvincular)', () => {
    expect(updateAccessGroupSchema.parse({ linkedTierName: 'gold' }).linkedTierName).toBe('gold');
    expect(updateAccessGroupSchema.parse({ linkedTierName: null }).linkedTierName).toBeNull();
  });
});

describe('assignAccessGroupMembersSchema', () => {
  it('exige al menos 1 y como mucho 500 userIds UUID', () => {
    expect(() => assignAccessGroupMembersSchema.parse({ userIds: [] })).toThrow();
    expect(() => assignAccessGroupMembersSchema.parse({ userIds: ['x'] })).toThrow();
    const ok = assignAccessGroupMembersSchema.parse({ userIds: [UUID] });
    expect(ok.userIds).toHaveLength(1);
  });
});
