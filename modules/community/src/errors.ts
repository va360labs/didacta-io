export class CommunityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommunityError';
  }
}

export class PostNotFoundError extends CommunityError {
  constructor() {
    super('POST_NOT_FOUND', 'El post no existe o no pertenece al tenant');
  }
}

export class CommentNotFoundError extends CommunityError {
  constructor() {
    super('COMMENT_NOT_FOUND', 'El comentario no existe o no pertenece al tenant');
  }
}

export class ReactionTargetMissingError extends CommunityError {
  constructor() {
    super(
      'REACTION_TARGET_MISSING',
      'Una reacción debe apuntar a postId o a commentId, no a ambos ni a ninguno',
    );
  }
}

export class NotAuthorError extends CommunityError {
  constructor() {
    super('NOT_AUTHOR', 'Solo el autor puede modificar o eliminar este recurso');
  }
}
