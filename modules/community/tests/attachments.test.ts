import { describe, expect, it } from 'vitest';
import {
  flattenPostAttachments,
  parseBodyAttachments,
  type PostForAttachments,
} from '../src/attachments.js';

describe('parseBodyAttachments', () => {
  it('devuelve vacío cuando no hay marcador', () => {
    expect(parseBodyAttachments('hola mundo')).toEqual({ images: [], files: [] });
  });

  it('extrae imágenes y archivos del marcador', () => {
    const body =
      'texto\n\n<!--didacta-attachments:{"images":[{"url":"https://x/a.png","name":"a.png"}],"files":[{"url":"https://x/b.pdf","name":"b.pdf","size":10}]}-->';
    expect(parseBodyAttachments(body)).toEqual({
      images: [{ url: 'https://x/a.png', name: 'a.png' }],
      files: [{ url: 'https://x/b.pdf', name: 'b.pdf', size: 10 }],
    });
  });

  it('es tolerante a JSON inválido o marcador sin cerrar', () => {
    expect(parseBodyAttachments('x<!--didacta-attachments:{no json-->')).toEqual({
      images: [],
      files: [],
    });
    expect(parseBodyAttachments('x<!--didacta-attachments:{"images":[]}')).toEqual({
      images: [],
      files: [],
    });
  });

  it('ignora images/files que no sean arrays', () => {
    const body = 'x<!--didacta-attachments:{"images":"nope","files":null}-->';
    expect(parseBodyAttachments(body)).toEqual({ images: [], files: [] });
  });
});

describe('flattenPostAttachments', () => {
  const post = (over: Partial<PostForAttachments>): PostForAttachments => ({
    id: 'p1',
    title: 'Título',
    body: '',
    authorId: 'u1',
    authorDisplayName: 'Ana',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    ...over,
  });

  it('aplana imágenes y archivos con la metadata del post', () => {
    const posts = [
      post({
        id: 'p1',
        title: 'Post 1',
        body: 'hola<!--didacta-attachments:{"images":[{"url":"https://x/a.png","name":"a.png"}],"files":[{"url":"https://x/d.pdf","name":"d.pdf","size":5}]}-->',
      }),
    ];
    const out = flattenPostAttachments(posts);
    expect(out).toEqual([
      {
        kind: 'image',
        url: 'https://x/a.png',
        name: 'a.png',
        postId: 'p1',
        postTitle: 'Post 1',
        authorId: 'u1',
        authorName: 'Ana',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        kind: 'file',
        url: 'https://x/d.pdf',
        name: 'd.pdf',
        size: 5,
        postId: 'p1',
        postTitle: 'Post 1',
        authorId: 'u1',
        authorName: 'Ana',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
  });

  it('descarta adjuntos con URL no segura (p. ej. javascript:)', () => {
    const posts = [
      post({
        body: 'x<!--didacta-attachments:{"images":[{"url":"javascript:alert(1)","name":"evil"},{"url":"https://ok/a.png","name":"ok"}],"files":[]}-->',
      }),
    ];
    const out = flattenPostAttachments(posts);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://ok/a.png');
  });

  it('acepta rutas relativas del propio host', () => {
    const posts = [
      post({
        body: 'x<!--didacta-attachments:{"images":[{"url":"/api/v1/storage/file/x.png","name":"x"}],"files":[]}-->',
      }),
    ];
    expect(flattenPostAttachments(posts)).toHaveLength(1);
  });

  it('posts sin adjuntos no aportan nada', () => {
    expect(flattenPostAttachments([post({ body: 'sin adjuntos' })])).toEqual([]);
  });
});
