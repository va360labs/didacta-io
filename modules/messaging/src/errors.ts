/**
 * Errores de dominio de mod.messaging. Códigos estables en MAYÚSCULAS con
 * prefijo MESSAGING_ — el filtro HTTP del host los mapea a status codes y el
 * frontend los humaniza por código.
 */

export class MessagingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export class ConversationNotFoundError extends MessagingError {
  constructor() {
    super('La conversación no existe o no está disponible.', 'MESSAGING_CONVERSATION_NOT_FOUND');
    this.name = 'ConversationNotFoundError';
  }
}

export class NotParticipantError extends MessagingError {
  constructor() {
    super('No participas en esta conversación.', 'MESSAGING_NOT_PARTICIPANT');
    this.name = 'NotParticipantError';
  }
}

export class SelfDmError extends MessagingError {
  constructor() {
    super('No puedes abrir un directo contigo mismo.', 'MESSAGING_SELF_DM');
    this.name = 'SelfDmError';
  }
}

export class TargetUserNotFoundError extends MessagingError {
  constructor() {
    super('El usuario destinatario no existe en esta comunidad.', 'MESSAGING_USER_NOT_FOUND');
    this.name = 'TargetUserNotFoundError';
  }
}

export class SpaceNotFoundError extends MessagingError {
  constructor(slug: string) {
    super(`El espacio "${slug}" no existe.`, 'MESSAGING_SPACE_NOT_FOUND');
    this.name = 'SpaceNotFoundError';
  }
}

export class MessageBodyInvalidError extends MessagingError {
  constructor() {
    super('El mensaje debe tener entre 1 y 4000 caracteres.', 'MESSAGING_BODY_INVALID');
    this.name = 'MessageBodyInvalidError';
  }
}

export class StaffFacultyError extends MessagingError {
  constructor() {
    super(
      'El equipo docente no tiene canal de profesores propio: responde a los alumnos desde sus consultas.',
      'MESSAGING_STAFF_NO_FACULTY',
    );
    this.name = 'StaffFacultyError';
  }
}
