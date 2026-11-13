import { describe, expect, it } from 'vitest';
import { CommunityService, stripAttachmentMarker } from '../src/community.service.js';

/**
 * «Últimos comentarios» de la barra lateral: solo lo que cualquier miembro
 * puede abrir (nada borrado ni oculto, ni dentro de un post oculto), del aula
 * pedida, y con un extracto de UNA línea sin el JSON de los adjuntos.
 */

interface Row {
  id: string;
  tenantId: string;
  postId: string;
  authorId: string;
  authorDisplayName: string | null;
  body: string;
  createdAt: Date;
  deletedAt: Date | null;
  hiddenAt: Date | null;
  post: { tenantId: string; title: string; deletedAt: Date | null; hiddenAt: Date | null };
}

function makeService(rows: Row[]) {
  const seen: unknown[] = [];
  const prisma = {
    modCommunityComment: {
      async findMany(args: any) {
        seen.push(args);
        const w = args.where;
        return rows
          .filter(
            (r) =>
              r.tenantId === w.tenantId &&
              (w.deletedAt !== null || r.deletedAt === null) &&
              (w.hiddenAt !== null || r.hiddenAt === null) &&
              r.post.tenantId === w.post.tenantId &&
              (w.post.deletedAt !== null || r.post.deletedAt === null) &&
              (w.post.hiddenAt !== null || r.post.hiddenAt === null),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take)
          .map((r) => ({
            id: r.id,
            postId: r.postId,
            authorId: r.authorId,
            authorDisplayName: r.authorDisplayName,
            body: r.body,
            createdAt: r.createdAt,
            post: { title: r.post.title },
          }));
      },
    },
  };
  const service = new CommunityService(prisma as never, {} as never);
  return { service, seen };
}

const visiblePost = { tenantId: 't1', title: 'Best grinder?', deletedAt: null, hiddenAt: null };

function row(id: string, minutes: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    tenantId: 't1',
    postId: 'p1',
    authorId: 'u1',
    authorDisplayName: 'Ana',
    body: `comentario ${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 10, 10, minutes)),
    deletedAt: null,
    hiddenAt: null,
    post: visiblePost,
    ...extra,
  };
}

describe('CommunityService.listRecentComments', () => {
  it('devuelve los últimos visibles del aula, del más nuevo al más viejo', async () => {
    const { service } = makeService([
      row('viejo', 1),
      row('nuevo', 5),
      row('borrado', 6, { deletedAt: new Date() }),
      row('oculto', 7, { hiddenAt: new Date() }),
      row('en-post-oculto', 8, { post: { ...visiblePost, hiddenAt: new Date() } }),
      row('en-post-borrado', 9, { post: { ...visiblePost, deletedAt: new Date() } }),
      row('de-otra-aula', 10, { tenantId: 't2', post: { ...visiblePost, tenantId: 't2' } }),
    ]);
    const out = await service.listRecentComments('t1', 3);
    expect(out.map((c) => c.id)).toEqual(['nuevo', 'viejo']);
    expect(out[0]).toMatchObject({ postId: 'p1', postTitle: 'Best grinder?', authorId: 'u1' });
  });

  it('filtra por aula también en el post y acota el límite', async () => {
    const { service, seen } = makeService([]);
    await service.listRecentComments('t1', 500);
    await service.listRecentComments('t1', 0);
    const [grande, cero] = seen as Array<{ where: any; take: number }>;
    expect(grande!.where).toMatchObject({
      tenantId: 't1',
      deletedAt: null,
      hiddenAt: null,
      post: { tenantId: 't1', deletedAt: null, hiddenAt: null },
    });
    expect(grande!.take).toBe(10);
    expect(cero!.take).toBe(1);
  });

  it('el extracto es una línea y no lleva el JSON de los adjuntos', async () => {
    const body =
      'Mira esta foto\n\nde mi latte <!--didacta-attachments:{"images":[{"url":"https://x/y.png","name":"y.png"}]}-->';
    const { service } = makeService([row('c', 1, { body })]);
    const [c] = await service.listRecentComments('t1');
    expect(c!.excerpt).toBe('Mira esta foto de mi latte');
  });
});

describe('stripAttachmentMarker', () => {
  it('quita comentarios HTML, también uno sin cerrar', () => {
    expect(stripAttachmentMarker('hola <!--x-->mundo').replace(/\s+/g, ' ')).toBe('hola mundo');
    expect(stripAttachmentMarker('hola <!--didacta-attachments:{"images"').trim()).toBe('hola');
  });
});
