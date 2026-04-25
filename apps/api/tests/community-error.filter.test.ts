import { describe, expect, it, vi } from 'vitest';
import {
  CommentNotFoundError,
  NotAuthorError,
  PostNotFoundError,
  ReactionTargetMissingError,
} from '@learnship/mod-community';
import { CommunityErrorFilter } from '../src/modules/community-error.filter';

function makeHost(captured: { status?: number; body?: unknown }) {
  const reply = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    send(b: unknown) {
      captured.body = b;
      return this;
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => reply,
    }),
  } as never;
}

describe('CommunityErrorFilter', () => {
  const filter = new CommunityErrorFilter();

  it.each([
    [new PostNotFoundError(), 404, 'POST_NOT_FOUND'],
    [new CommentNotFoundError(), 404, 'COMMENT_NOT_FOUND'],
    [new ReactionTargetMissingError(), 422, 'REACTION_TARGET_MISSING'],
    [new NotAuthorError(), 403, 'NOT_AUTHOR'],
  ])('mapea %s al status HTTP correcto', (err, expectedStatus, expectedCode) => {
    const captured: { status?: number; body?: unknown } = {};
    filter.catch(err, makeHost(captured));
    expect(captured.status).toBe(expectedStatus);
    expect(captured.body).toMatchObject({
      statusCode: expectedStatus,
      code: expectedCode,
      message: expect.any(String),
    });
  });

  it('contexto no-http: lanza HttpException', () => {
    const host = {
      getType: () => 'rpc',
      switchToHttp: () => ({ getResponse: vi.fn() }),
    } as never;
    expect(() => filter.catch(new PostNotFoundError(), host)).toThrowError();
  });
});
