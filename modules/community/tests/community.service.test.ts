import { describe, expect, it } from 'vitest';
import { CommunityService } from '../src/community.service.js';
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
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
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
        return filtered.slice(0, args.take ?? 50);
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
