import { describe, expect, it } from 'vitest';
import {
  isOwnedEnrollment,
  splitCoursesBySection,
  type CatalogEnrollmentInfo,
} from './catalog-sections';

const course = (id: string) => ({ id, title: `Curso ${id}` });
const enrolled = (
  status: CatalogEnrollmentInfo['status'],
  progressPercent = 0,
): CatalogEnrollmentInfo => ({ status, progressPercent });

describe('isOwnedEnrollment', () => {
  it('cuenta como propio si la matrícula está activa o completada', () => {
    expect(isOwnedEnrollment(enrolled('ACTIVE'))).toBe(true);
    expect(isOwnedEnrollment(enrolled('COMPLETED', 100))).toBe(true);
  });

  it('no cuenta como propio si está cancelada o no existe', () => {
    expect(isOwnedEnrollment(enrolled('CANCELLED'))).toBe(false);
    expect(isOwnedEnrollment(undefined)).toBe(false);
  });
});

describe('splitCoursesBySection', () => {
  it('separa los cursos matriculados del resto del catálogo', () => {
    const courses = [course('a'), course('b'), course('c'), course('d')];
    const enrollments = new Map<string, CatalogEnrollmentInfo>([
      ['a', enrolled('ACTIVE', 40)],
      ['c', enrolled('COMPLETED', 100)],
    ]);

    const { mine, others } = splitCoursesBySection(courses, enrollments);

    expect(mine.map((c) => c.id)).toEqual(['a', 'c']);
    expect(others.map((c) => c.id)).toEqual(['b', 'd']);
  });

  it('una matrícula cancelada devuelve el curso al catálogo general', () => {
    const { mine, others } = splitCoursesBySection(
      [course('a')],
      new Map([['a', enrolled('CANCELLED')]]),
    );

    expect(mine).toEqual([]);
    expect(others.map((c) => c.id)).toEqual(['a']);
  });

  it('preserva el orden que devuelve el backend en cada sección', () => {
    const courses = [course('1'), course('2'), course('3'), course('4'), course('5')];
    const enrollments = new Map<string, CatalogEnrollmentInfo>([
      ['4', enrolled('ACTIVE')],
      ['2', enrolled('ACTIVE')],
    ]);

    const { mine, others } = splitCoursesBySection(courses, enrollments);

    expect(mine.map((c) => c.id)).toEqual(['2', '4']);
    expect(others.map((c) => c.id)).toEqual(['1', '3', '5']);
  });

  it('sin matrículas todo cae en "otros" y no se pierde ningún curso', () => {
    const courses = [course('a'), course('b')];
    const { mine, others } = splitCoursesBySection(courses, new Map());

    expect(mine).toEqual([]);
    expect(others).toHaveLength(2);
  });

  it('ignora matrículas de cursos que no están en el listado filtrado', () => {
    const { mine, others } = splitCoursesBySection(
      [course('a')],
      new Map([
        ['a', enrolled('ACTIVE')],
        ['zzz', enrolled('ACTIVE')],
      ]),
    );

    expect(mine.map((c) => c.id)).toEqual(['a']);
    expect(others).toEqual([]);
  });

  it('con catálogo vacío devuelve dos secciones vacías', () => {
    expect(splitCoursesBySection([], new Map())).toEqual({ mine: [], others: [] });
  });
});
