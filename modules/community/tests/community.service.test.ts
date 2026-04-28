import { describe, expect, it } from 'vitest';
import { CommunityService, parseMentionHandles } from '../src/community.service.js';
import {
  CommentNotFoundError,
  NotAuthorError,
  PostNotFoundError,
  ReactionTargetMissingError,
} from '../src/errors.js';

interface PostRow {
  id: string;
  tenantId: string;
  authorId: string;
  authorDisplayName: string | null;
  courseId: string | null;
  title: string;
  body: string;
  tags: string[];
  deletedAt: Date | null;
  createdAt: Date;
}
interface CommentRow {
  id: string;
  tenantId: string;
  postId: string;
  authorId: string;
  body: string;
  authorDisplayName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}
interface ReactionRow {
  id: string;
  tenantId: string;
  postId: string | null;
  commentId: string | null;
  authorId: string;
  emoji: string;
}

function makeFakePrisma() {
  const posts: PostRow[] = [];
  const comments: CommentRow[] = [];
  const reactions: ReactionRow[] = [];
  let pId = 1,
    cId = 1,
    rId = 1;

  return {
    modCommunityPost: {
      async create(args: { data: Partial<PostRow> }): Promise<PostRow> {
        const row: PostRow = {
          id: `post-${pId++}`,
          tenantId: '',
          authorId: '',
          authorDisplayName: null,
          courseId: null,
          title: '',
          body: '',
          tags: [],
          deletedAt: null,
          createdAt: new Date(),
          ...(args.data as PostRow),
        };
        posts.push(row);
        return row;
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        return (
          posts.find(
            (p) =>
              (args.where.id === undefined || p.id === args.where.id) &&
              (args.where.tenantId === undefined || p.tenantId === args.where.tenantId) &&
              (args.where.deletedAt === undefined || p.deletedAt === args.where.deletedAt),
          ) ?? null
        );
      },
      async findMany(args: {
        where: Record<string, unknown>;
        take?: number;
        orderBy?: Array<Record<string, unknown>> | Record<string, unknown>;
        include?: {
          _count?: { select?: { comments?: unknown } };
          reactions?: { where?: { commentId?: null } };
        };
      }) {
        const w = args.where;
        const filtered = posts.filter(
          (p) =>
            (w.tenantId === undefined || p.tenantId === w.tenantId) &&
            (w.deletedAt === undefined || p.deletedAt === w.deletedAt) &&
            (w.courseId === undefined || p.courseId === w.courseId) &&
            (w.authorId === undefined || p.authorId === w.authorId) &&
            (w.tags === undefined ||
              !(w.tags as { has?: string }).has ||
              p.tags.includes((w.tags as { has?: string }).has!)),
        );

        // Aplicar orderBy (puede ser un objeto o array). Implementamos los
        // 3 modos que el service actual usa: createdAt asc/desc y
        // comments._count desc (con createdAt desc como tiebreak).
        const orderArr = Array.isArray(args.orderBy)
          ? args.orderBy
          : args.orderBy
            ? [args.orderBy]
            : [];
        const sorted = [...filtered].sort((a, b) => {
          for (const clause of orderArr) {
            if ('createdAt' in clause) {
              const dir = (clause as { createdAt: 'asc' | 'desc' }).createdAt;
              const diff = a.createdAt.getTime() - b.createdAt.getTime();
              if (diff !== 0) return dir === 'asc' ? diff : -diff;
            } else if ('comments' in clause) {
              const cntA = comments.filter((c) => c.postId === a.id && c.deletedAt === null).length;
              const cntB = comments.filter((c) => c.postId === b.id && c.deletedAt === null).length;
              if (cntA !== cntB) return cntB - cntA; // siempre desc según el use-case
            }
          }
          return 0;
        });

        const sliced = sorted.slice(0, args.take ?? 50);
        if (
          args.include?._count?.select?.comments !== undefined ||
          args.include?.reactions !== undefined
        ) {
          return sliced.map((p) => ({
            ...p,
            ...(args.include?._count?.select?.comments !== undefined
              ? {
                  _count: {
                    comments: comments.filter((c) => c.postId === p.id && c.deletedAt === null)
                      .length,
                  },
                }
              : {}),
            ...(args.include?.reactions !== undefined
              ? { reactions: reactions.filter((r) => r.postId === p.id && r.commentId === null) }
              : {}),
          }));
        }
        return sliced;
      },
      async update(args: { where: { id: string }; data: Partial<PostRow> }) {
        const found = posts.find((p) => p.id === args.where.id);
        if (!found) throw new Error('not found');
        Object.assign(found, args.data);
        return found;
      },
    },
    modCommunityComment: {
      async create(args: { data: Partial<CommentRow> }): Promise<CommentRow> {
        const row: CommentRow = {
          id: `cmt-${cId++}`,
          tenantId: '',
          postId: '',
          authorId: '',
          body: '',
          authorDisplayName: null,
          deletedAt: null,
          createdAt: new Date(),
          ...(args.data as CommentRow),
        };
        comments.push(row);
        return row;
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        return (
          comments.find(
            (c) =>
              (args.where.id === undefined || c.id === args.where.id) &&
              (args.where.tenantId === undefined || c.tenantId === args.where.tenantId) &&
              (args.where.deletedAt === undefined || c.deletedAt === args.where.deletedAt),
          ) ?? null
        );
      },
      async update(args: { where: { id: string }; data: Partial<CommentRow> }) {
        const found = comments.find((c) => c.id === args.where.id);
        if (!found) throw new Error('not found');
        Object.assign(found, args.data);
        return found;
      },
    },
    modCommunityReaction: {
      async findFirst(args: { where: Record<string, unknown> }) {
        const w = args.where;
        return (
          reactions.find(
            (r) =>
              (w.tenantId === undefined || r.tenantId === w.tenantId) &&
              (w.id === undefined || r.id === w.id) &&
              (w.postId === undefined || r.postId === w.postId) &&
              (w.commentId === undefined || r.commentId === w.commentId) &&
              (w.authorId === undefined || r.authorId === w.authorId) &&
              (w.emoji === undefined || r.emoji === w.emoji),
          ) ?? null
        );
      },
      async create(args: { data: Partial<ReactionRow> }): Promise<ReactionRow> {
        const row: ReactionRow = {
          id: `rxn-${rId++}`,
          tenantId: '',
          postId: null,
          commentId: null,
          authorId: '',
          emoji: '',
          ...(args.data as ReactionRow),
        };
        reactions.push(row);
        return row;
      },
      async delete(args: { where: { id: string } }) {
        const idx = reactions.findIndex((r) => r.id === args.where.id);
        if (idx >= 0) reactions.splice(idx, 1);
      },
    },
    _posts: posts,
    _comments: comments,
    _reactions: reactions,
  };
}

const trackingCtx = (events: { name: string; data: unknown }[]) =>
  ({
    eventBus: {
      publish: async (e: { name: string; data: unknown }) => {
        events.push(e);
      },
    },
  }) as never;

describe('CommunityService.createPost', () => {
  it('persiste con autor + tags + emite community.post.created', async () => {
    const prisma = makeFakePrisma();
    const events: { name: string; data: unknown }[] = [];
    const svc = new CommunityService(prisma as never, trackingCtx(events));

    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: 'Valen' },
      {
        title: 'Hola',
        body: 'Mundo',
        tags: ['general'],
      },
    );

    expect(post.title).toBe('Hola');
    expect(post.tags).toEqual(['general']);
    expect(post.authorDisplayName).toBe('Valen');
    expect(events[0]?.name).toBe('community.post.created');
  });

  it('lista filtra por courseId / tag', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));

    await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      {
        title: 'A',
        body: 'b',
        courseId: 'c1',
        tags: ['ayuda'],
      },
    );
    await svc.createPost(
      't1',
      { id: 'u2', displayName: null },
      {
        title: 'B',
        body: 'b',
        courseId: 'c2',
        tags: ['general'],
      },
    );

    const list1 = await svc.listPosts('t1', { courseId: 'c1', limit: 50 });
    expect(list1).toHaveLength(1);
    expect(list1[0]?.title).toBe('A');

    const list2 = await svc.listPosts('t1', { tag: 'general', limit: 50 });
    expect(list2).toHaveLength(1);
    expect(list2[0]?.title).toBe('B');
  });

  it('listPosts incluye _count.comments con el total visible', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'P', body: 'body' },
    );
    await svc.addComment('t1', post.id, { id: 'u2', displayName: null }, { body: 'first' });
    await svc.addComment('t1', post.id, { id: 'u3', displayName: null }, { body: 'second' });

    const list = await svc.listPosts('t1', { limit: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]?._count?.comments).toBe(2);
  });

  it('listPosts devuelve _count.comments=0 para post sin comentarios', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await svc.createPost('t1', { id: 'u1', displayName: null }, { title: 'P', body: 'body' });
    const list = await svc.listPosts('t1', { limit: 50 });
    expect(list[0]?._count?.comments).toBe(0);
  });

  it('sort=oldest invierte el orden (más antiguos primero)', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const a = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'A', body: 'a' },
    );
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'B', body: 'b' },
    );

    const recent = await svc.listPosts('t1', { sort: 'recent', limit: 50 });
    expect(recent.map((p) => p.id)).toEqual([b.id, a.id]);

    const oldest = await svc.listPosts('t1', { sort: 'oldest', limit: 50 });
    expect(oldest.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('listPosts incluye reactions del post (no de comentarios)', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'P', body: 'b' },
    );
    await svc.addReaction('t1', 'u2', { postId: post.id, emoji: '👍' });
    await svc.addReaction('t1', 'u3', { postId: post.id, emoji: '❤️' });

    const list = await svc.listPosts('t1', { limit: 50 });
    expect(list[0]?.reactions).toBeDefined();
    expect(list[0]?.reactions?.length).toBe(2);
    const emojis = (list[0]?.reactions ?? []).map((r) => r.emoji).sort();
    expect(emojis).toEqual(['❤️', '👍'].sort());
  });

  it('sort=most_commented prioriza el de más comentarios', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const a = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'A', body: 'a' },
    );
    const b = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      { title: 'B', body: 'b' },
    );
    // B tiene 2 comentarios, A tiene 1 → B debe quedar primero.
    await svc.addComment('t1', a.id, { id: 'u2', displayName: null }, { body: 'c1' });
    await svc.addComment('t1', b.id, { id: 'u2', displayName: null }, { body: 'c1' });
    await svc.addComment('t1', b.id, { id: 'u3', displayName: null }, { body: 'c2' });

    const list = await svc.listPosts('t1', { sort: 'most_commented', limit: 50 });
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });
});

describe('CommunityService.deletePost', () => {
  it('error si no es el autor', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      {
        title: 'X',
        body: 'y',
      },
    );
    await expect(svc.deletePost('t1', 'otro', post.id)).rejects.toBeInstanceOf(NotAuthorError);
  });

  it('error si no existe', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(svc.deletePost('t1', 'u1', 'nope')).rejects.toBeInstanceOf(PostNotFoundError);
  });

  it('soft-deletea (deletedAt poblado)', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      {
        title: 'X',
        body: 'y',
      },
    );
    await svc.deletePost('t1', 'u1', post.id);
    expect(prisma._posts[0]?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('CommunityService.addComment', () => {
  it('error si el post no existe', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(
      svc.addComment('t1', 'no-existe', { id: 'u1', displayName: null }, { body: 'hola' }),
    ).rejects.toBeInstanceOf(PostNotFoundError);
  });

  it('persiste y emite evento', async () => {
    const prisma = makeFakePrisma();
    const events: { name: string; data: unknown }[] = [];
    const svc = new CommunityService(prisma as never, trackingCtx(events));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      {
        title: 'P',
        body: 'b',
      },
    );
    const comment = await svc.addComment(
      't1',
      post.id,
      { id: 'u2', displayName: 'Otro' },
      { body: 'respuesta' },
    );
    expect(comment.body).toBe('respuesta');
    expect(comment.authorDisplayName).toBe('Otro');
    expect(events.find((e) => e.name === 'community.comment.created')).toBeDefined();
  });
});

describe('CommunityService.deleteComment', () => {
  it('solo el autor puede borrar', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const post = await svc.createPost(
      't1',
      { id: 'u1', displayName: null },
      {
        title: 'P',
        body: 'b',
      },
    );
    const c = await svc.addComment('t1', post.id, { id: 'u2', displayName: null }, { body: 'x' });
    await expect(svc.deleteComment('t1', 'otro', c.id)).rejects.toBeInstanceOf(NotAuthorError);
    await svc.deleteComment('t1', 'u2', c.id);
    expect(prisma._comments[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('error si el comment no existe', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(svc.deleteComment('t1', 'u1', 'nope')).rejects.toBeInstanceOf(
      CommentNotFoundError,
    );
  });
});

describe('CommunityService.addReaction', () => {
  it('error si no se manda postId ni commentId', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(svc.addReaction('t1', 'u1', { emoji: '👍' })).rejects.toBeInstanceOf(
      ReactionTargetMissingError,
    );
  });

  it('error si se mandan ambos', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(
      svc.addReaction('t1', 'u1', { postId: 'p1', commentId: 'c1', emoji: '👍' }),
    ).rejects.toBeInstanceOf(ReactionTargetMissingError);
  });

  it('reacciona a post + emite evento', async () => {
    const prisma = makeFakePrisma();
    const events: { name: string; data: unknown }[] = [];
    const svc = new CommunityService(prisma as never, trackingCtx(events));
    const r = await svc.addReaction('t1', 'u1', { postId: 'post-x', emoji: '👍' });
    expect(r.postId).toBe('post-x');
    expect(r.emoji).toBe('👍');
    expect(events[0]?.name).toBe('community.reaction.added');
  });

  it('idempotente: misma reaccion del mismo author no duplica', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const r1 = await svc.addReaction('t1', 'u1', { postId: 'p', emoji: '👍' });
    const r2 = await svc.addReaction('t1', 'u1', { postId: 'p', emoji: '👍' });
    expect(r1.id).toBe(r2.id);
    expect(prisma._reactions).toHaveLength(1);
  });

  it('reacciona a comment', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const r = await svc.addReaction('t1', 'u1', { commentId: 'cmt-x', emoji: '🎉' });
    expect(r.commentId).toBe('cmt-x');
    expect(r.postId).toBeNull();
  });
});

describe('CommunityService.removeReaction', () => {
  it('idempotente: no rompe si la reaccion no existe', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    await expect(svc.removeReaction('t1', 'u1', 'nope')).resolves.toBeUndefined();
  });

  it('borra la reaccion del autor', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const r = await svc.addReaction('t1', 'u1', { postId: 'p', emoji: '👍' });
    await svc.removeReaction('t1', 'u1', r.id);
    expect(prisma._reactions).toHaveLength(0);
  });

  it('error si intenta borrar reaccion ajena', async () => {
    const prisma = makeFakePrisma();
    const svc = new CommunityService(prisma as never, trackingCtx([]));
    const r = await svc.addReaction('t1', 'u1', { postId: 'p', emoji: '👍' });
    await expect(svc.removeReaction('t1', 'otro', r.id)).rejects.toBeInstanceOf(NotAuthorError);
  });
});

describe('parseMentionHandles', () => {
  it('extrae handles únicos del body', () => {
    expect(parseMentionHandles('Hola @juan, ¿cómo estás?')).toEqual(['juan']);
    expect(parseMentionHandles('@maria @pedro y @maria de nuevo')).toEqual(['maria', 'pedro']);
    expect(parseMentionHandles('email@dominio.com no es mención')).toEqual([]);
    expect(parseMentionHandles('(@ana) [@bea] @carlos.j')).toEqual(['ana', 'bea', 'carlos.j']);
    expect(parseMentionHandles('sin menciones aquí')).toEqual([]);
    expect(parseMentionHandles('')).toEqual([]);
  });

  it('case-insensitive en la deduplicación pero preserva el casing original', () => {
    // El primer matching gana en casing.
    expect(parseMentionHandles('@Juan dice hola @juan')).toEqual(['Juan']);
  });

  it('acepta letras, números, guion bajo, punto y guion', () => {
    expect(parseMentionHandles('@user_123 @user.name @user-name @other')).toEqual([
      'user_123',
      'user.name',
      'user-name',
      'other',
    ]);
  });
});

interface UserPrefRow {
  id: string;
  tenantId: string;
  userId: string;
  digestOptOut: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  tenantId: string;
  status: string;
}

function makePrefsPrisma(opts: { users: UserRow[]; prefs?: UserPrefRow[] } = { users: [] }) {
  const prefs: UserPrefRow[] = opts.prefs ?? [];
  const users = opts.users;

  return {
    user: {
      async findMany(args: { where: { status?: string }; select?: unknown; take?: number }) {
        return users
          .filter((u) => (args.where.status ? u.status === args.where.status : true))
          .slice(0, args.take ?? 50_000);
      },
    },
    modCommunityUserPref: {
      async findMany(args: {
        where: {
          digestOptOut?: boolean;
          userId?: { in: string[] };
        };
        select?: unknown;
      }) {
        return prefs.filter((p) => {
          if (args.where.digestOptOut !== undefined && p.digestOptOut !== args.where.digestOptOut)
            return false;
          if (args.where.userId?.in && !args.where.userId.in.includes(p.userId)) return false;
          return true;
        });
      },
      async findUnique(args: { where: { tenantId_userId: { tenantId: string; userId: string } } }) {
        const k = args.where.tenantId_userId;
        return prefs.find((p) => p.tenantId === k.tenantId && p.userId === k.userId) ?? null;
      },
      async upsert(args: {
        where: { tenantId_userId: { tenantId: string; userId: string } };
        create: UserPrefRow;
        update: Partial<UserPrefRow>;
      }) {
        const k = args.where.tenantId_userId;
        const idx = prefs.findIndex((p) => p.tenantId === k.tenantId && p.userId === k.userId);
        if (idx === -1) {
          const row: UserPrefRow = {
            ...args.create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          prefs.push(row);
          return row;
        }
        prefs[idx] = { ...prefs[idx]!, ...args.update, updatedAt: new Date() };
        return prefs[idx]!;
      },
    },
    _prefs: prefs,
  };
}

describe('CommunityService preferences', () => {
  it('getUserPreferences devuelve defaults si no hay fila', async () => {
    const prisma = makePrefsPrisma({ users: [] });
    const ctx = { eventBus: { publish: async () => {} } } as never;
    const svc = new CommunityService(prisma as never, ctx);
    const out = await svc.getUserPreferences('t1', 'u1');
    expect(out).toEqual({ digestOptOut: false });
  });

  it('updateUserPreferences hace upsert correctamente (create + update)', async () => {
    const prisma = makePrefsPrisma({ users: [] });
    const ctx = { eventBus: { publish: async () => {} } } as never;
    const svc = new CommunityService(prisma as never, ctx);

    // Primer call: create.
    const after1 = await svc.updateUserPreferences('t1', 'u1', { digestOptOut: true });
    expect(after1).toEqual({ digestOptOut: true });
    expect(prisma._prefs).toHaveLength(1);

    // Segundo: update.
    const after2 = await svc.updateUserPreferences('t1', 'u1', { digestOptOut: false });
    expect(after2).toEqual({ digestOptOut: false });
    expect(prisma._prefs).toHaveLength(1); // upsert, no segunda fila
  });

  it('listActiveUsersForDigest excluye usuarios con digestOptOut=true', async () => {
    const prisma = makePrefsPrisma({
      users: [
        { id: 'u1', tenantId: 't1', status: 'ACTIVE' },
        { id: 'u2', tenantId: 't1', status: 'ACTIVE' },
        { id: 'u3', tenantId: 't1', status: 'INACTIVE' }, // ya filtrado por status
      ],
      prefs: [
        {
          id: 'p1',
          tenantId: 't1',
          userId: 'u2',
          digestOptOut: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const ctx = { eventBus: { publish: async () => {} } } as never;
    const svc = new CommunityService(prisma as never, ctx);
    const out = await svc.listActiveUsersForDigest();
    expect(out).toEqual([{ tenantId: 't1', userId: 'u1' }]);
  });

  it('listActiveUsersForDigest devuelve [] si no hay usuarios activos', async () => {
    const prisma = makePrefsPrisma({ users: [] });
    const ctx = { eventBus: { publish: async () => {} } } as never;
    const svc = new CommunityService(prisma as never, ctx);
    expect(await svc.listActiveUsersForDigest()).toEqual([]);
  });
});

interface FakeTag {
  id: string;
  tenantId: string;
  name: string;
  color: string;
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeTagsPrisma() {
  const tags: FakeTag[] = [];
  let counter = 0;
  return {
    modCommunityTag: {
      async findMany(args: { where?: { tenantId?: string }; orderBy?: { name?: 'asc' | 'desc' } }) {
        let rows = tags.slice();
        if (args.where?.tenantId !== undefined) {
          rows = rows.filter((t) => t.tenantId === args.where!.tenantId);
        }
        if (args.orderBy?.name === 'asc') {
          rows.sort((a, b) => a.name.localeCompare(b.name));
        }
        return rows;
      },
      async findFirst(args: { where: { id?: string; tenantId?: string } }) {
        return (
          tags.find(
            (t) =>
              (args.where.id === undefined || t.id === args.where.id) &&
              (args.where.tenantId === undefined || t.tenantId === args.where.tenantId),
          ) ?? null
        );
      },
      async findUnique(args: { where: { tenantId_name?: { tenantId: string; name: string } } }) {
        const k = args.where.tenantId_name;
        if (!k) return null;
        return tags.find((t) => t.tenantId === k.tenantId && t.name === k.name) ?? null;
      },
      async create(args: {
        data: { id: string; tenantId: string; name: string; color: string; icon: string | null };
      }) {
        const row: FakeTag = {
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tags.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: Partial<FakeTag> }) {
        const idx = tags.findIndex((t) => t.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        tags[idx] = { ...tags[idx]!, ...args.data, updatedAt: new Date() };
        return tags[idx]!;
      },
      async delete(args: { where: { id: string } }) {
        const idx = tags.findIndex((t) => t.id === args.where.id);
        if (idx === -1) throw new Error('not found');
        const [removed] = tags.splice(idx, 1);
        return removed!;
      },
    },
    _tags: tags,
    _nextId: () => `tag-${++counter}`,
  };
}

function makeTagsContext() {
  return {
    eventBus: { publish: async () => {} },
    auditLog: { record: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    notificationHub: { send: async () => {} },
    hookRegistry: { run: async () => {} },
  } as never;
}

describe('CommunityService tags', () => {
  it('createTag normaliza el nombre a minúsculas y persiste', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    const tag = await svc.createTag('t1', 'u1', {
      name: '  Anuncios  ',
      color: '#1E5AA8',
      icon: 'message',
    });
    expect(tag.name).toBe('anuncios');
    expect(tag.color).toBe('#1E5AA8');
    expect(tag.icon).toBe('message');
    expect(prisma._tags).toHaveLength(1);
  });

  it('createTag rechaza si el nombre ya existe en el tenant (case-insensitive)', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    await svc.createTag('t1', 'u1', { name: 'ayuda', color: '#1E5AA8' });
    await expect(
      svc.createTag('t1', 'u1', { name: 'AYUDA', color: '#FF6F61' }),
    ).rejects.toMatchObject({ code: 'TAG_NAME_EXISTS' });
  });

  it('createTag permite el mismo nombre en tenants distintos', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    await svc.createTag('t1', 'u1', { name: 'ayuda', color: '#1E5AA8' });
    const t2 = await svc.createTag('t2', 'u1', { name: 'ayuda', color: '#FF6F61' });
    expect(t2.name).toBe('ayuda');
    expect(t2.tenantId).toBe('t2');
  });

  it('listTags devuelve sólo los del tenant ordenados alfabéticamente', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    await svc.createTag('t1', 'u1', { name: 'general', color: '#1E5AA8' });
    await svc.createTag('t1', 'u1', { name: 'ayuda', color: '#16A34A' });
    await svc.createTag('t2', 'u2', { name: 'otro-tenant', color: '#000000' });
    const tags = await svc.listTags('t1');
    expect(tags.map((t) => t.name)).toEqual(['ayuda', 'general']);
  });

  it('updateTag actualiza nombre, color e icono', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    const tag = await svc.createTag('t1', 'u1', { name: 'ayuda', color: '#1E5AA8' });
    const updated = await svc.updateTag('t1', 'u1', tag.id, {
      name: 'Soporte',
      color: '#FF6F61',
      icon: 'help',
    });
    expect(updated.name).toBe('soporte');
    expect(updated.color).toBe('#FF6F61');
    expect(updated.icon).toBe('help');
  });

  it('updateTag rechaza si el tag no existe en el tenant', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    await expect(svc.updateTag('t1', 'u1', 'no-existe', { name: 'x' })).rejects.toMatchObject({
      code: 'TAG_NOT_FOUND',
    });
  });

  it('deleteTag elimina el tag y rechaza si no existe', async () => {
    const prisma = makeTagsPrisma();
    const svc = new CommunityService(prisma as never, makeTagsContext());
    const tag = await svc.createTag('t1', 'u1', { name: 'borrame', color: '#1E5AA8' });
    await svc.deleteTag('t1', 'u1', tag.id);
    expect(prisma._tags).toHaveLength(0);
    await expect(svc.deleteTag('t1', 'u1', tag.id)).rejects.toMatchObject({
      code: 'TAG_NOT_FOUND',
    });
  });
});
