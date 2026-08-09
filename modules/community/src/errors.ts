/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Opciones de un error de dominio. `detail` es el dato que el `message` español
 * lleva incrustado y que el catálogo inglés se tragaba al traducir por `code`:
 * viaja como campo APARTE hasta el front. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface CommunityErrorOptions {
  readonly detail?: string;
}

export class CommunityError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: CommunityErrorOptions,
  ) {
    super(message);
    this.name = 'CommunityError';
    this.detail = options?.detail;
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

export class NestedRepliesTooDeepError extends CommunityError {
  constructor() {
    super(
      'NESTED_REPLIES_TOO_DEEP',
      'Los hilos solo permiten 1 nivel: respondé al comentario root, no a una respuesta.',
    );
  }
}

export class ParentCommentMismatchError extends CommunityError {
  constructor() {
    super('PARENT_COMMENT_MISMATCH', 'El comentario padre no pertenece al post indicado.');
  }
}

export class NotModeratorError extends CommunityError {
  constructor() {
    super('NOT_MODERATOR', 'Solo super_admin y tenant_admin pueden ocultar o restaurar contenido.');
  }
}

export class TagNotFoundError extends CommunityError {
  constructor(public readonly tagId: string) {
    super('TAG_NOT_FOUND', `El tag ${tagId} no existe o no pertenece al tenant`, { detail: tagId });
  }
}

export class TagNameAlreadyExistsError extends CommunityError {
  constructor(tagName: string) {
    super('TAG_NAME_EXISTS', `Ya existe un tag llamado "${tagName}" en este tenant`, {
      detail: tagName,
    });
  }
}

export class SpaceNotFoundError extends CommunityError {
  constructor(slug: string) {
    super('SPACE_NOT_FOUND', `El espacio '${slug}' no existe o no pertenece al tenant`, {
      detail: slug,
    });
  }
}

export class SpaceAlreadyExistsError extends CommunityError {
  constructor(slug: string) {
    super('SPACE_EXISTS', `Ya existe un espacio con slug '${slug}'.`, { detail: slug });
  }
}

export class SpaceNotDeletableError extends CommunityError {
  constructor(message: string) {
    super('SPACE_NOT_DELETABLE', message);
  }
}
