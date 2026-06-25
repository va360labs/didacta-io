import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GALLERY_FILTERS,
  filterGalleryAttachments,
  galleryAuthorOptions,
  type GalleryFilters,
} from './gallery';
import type { CommunityAttachment } from './client';

function att(over: Partial<CommunityAttachment>): CommunityAttachment {
  return {
    kind: 'image',
    url: 'https://x/a.png',
    name: 'a.png',
    postId: 'p1',
    postTitle: 'Post',
    authorId: 'u1',
    authorName: 'Ana',
    createdAt: '2026-06-01T10:00:00.000Z',
    ...over,
  };
}

const items: CommunityAttachment[] = [
  att({
    kind: 'image',
    name: 'foto-playa.png',
    authorId: 'u1',
    createdAt: '2026-06-10T08:00:00.000Z',
  }),
  att({
    kind: 'file',
    name: 'informe.pdf',
    authorId: 'u2',
    authorName: 'Beto',
    createdAt: '2026-06-05T08:00:00.000Z',
  }),
  att({
    kind: 'image',
    name: 'logo.png',
    authorId: 'u2',
    authorName: 'Beto',
    createdAt: '2026-06-20T08:00:00.000Z',
  }),
];

describe('filterGalleryAttachments', () => {
  it('sin filtros devuelve todo, ordenado por recientes', () => {
    const r = filterGalleryAttachments(items, DEFAULT_GALLERY_FILTERS);
    expect(r.map((a) => a.createdAt)).toEqual([
      '2026-06-20T08:00:00.000Z',
      '2026-06-10T08:00:00.000Z',
      '2026-06-05T08:00:00.000Z',
    ]);
  });

  it('orden antiguos invierte', () => {
    const r = filterGalleryAttachments(items, { ...DEFAULT_GALLERY_FILTERS, sort: 'oldest' });
    expect(r[0]?.createdAt).toBe('2026-06-05T08:00:00.000Z');
  });

  it('filtra por tipo', () => {
    expect(
      filterGalleryAttachments(items, { ...DEFAULT_GALLERY_FILTERS, type: 'file' }),
    ).toHaveLength(1);
    expect(
      filterGalleryAttachments(items, { ...DEFAULT_GALLERY_FILTERS, type: 'image' }),
    ).toHaveLength(2);
  });

  it('filtra por autor', () => {
    const r = filterGalleryAttachments(items, { ...DEFAULT_GALLERY_FILTERS, authorId: 'u2' });
    expect(r).toHaveLength(2);
    expect(r.every((a) => a.authorId === 'u2')).toBe(true);
  });

  it('busca por nombre (case-insensitive, substring)', () => {
    const r = filterGalleryAttachments(items, { ...DEFAULT_GALLERY_FILTERS, search: 'LOGO' });
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('logo.png');
  });

  it('filtra por rango de fechas inclusive', () => {
    const filters: GalleryFilters = {
      ...DEFAULT_GALLERY_FILTERS,
      from: '2026-06-05',
      to: '2026-06-10',
    };
    const r = filterGalleryAttachments(items, filters);
    expect(r.map((a) => a.createdAt).sort()).toEqual([
      '2026-06-05T08:00:00.000Z',
      '2026-06-10T08:00:00.000Z',
    ]);
  });

  it('combina filtros (tipo + autor)', () => {
    const r = filterGalleryAttachments(items, {
      ...DEFAULT_GALLERY_FILTERS,
      type: 'image',
      authorId: 'u2',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('logo.png');
  });
});

describe('galleryAuthorOptions', () => {
  it('lista autores únicos ordenados por nombre', () => {
    expect(galleryAuthorOptions(items)).toEqual([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Beto' },
    ]);
  });
});
