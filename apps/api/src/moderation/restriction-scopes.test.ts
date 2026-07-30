import { describe, expect, it } from 'vitest';
import { blockedBy, CONTENT_SCOPES, normalizePath, scopeLabels } from './restriction-scopes';

/**
 * Estos tests son la red de seguridad del fichero de reglas. La mitad
 * interesante no es "bloquea lo que tiene que bloquear" sino "NO bloquea lo
 * que nunca debe bloquear": una sanción de moderación que impide pagar o
 * seguir un curso es peor que el problema que arregla.
 */

const ALL = ['all'];

describe('normalizePath', () => {
  it('quita el prefijo global de la API', () => {
    expect(normalizePath('/api/v1/modules/community/posts')).toBe('/modules/community/posts');
  });

  it('quita el querystring', () => {
    expect(normalizePath('/api/v1/modules/community/posts?limit=20')).toBe(
      '/modules/community/posts',
    );
  });

  it('quita la barra final para que los patrones anclados no fallen', () => {
    expect(normalizePath('/api/v1/storage/upload/')).toBe('/storage/upload');
  });

  it('aguanta una ruta sin prefijo', () => {
    expect(normalizePath('/healthz')).toBe('/healthz');
  });
});

describe('blockedBy — lo que sí se bloquea', () => {
  it('corta crear un post con el área de comunidad', () => {
    expect(blockedBy(['community'], 'POST', '/api/v1/modules/community/posts')).toBe('Comunidad');
  });

  it('corta comentar', () => {
    expect(blockedBy(['community'], 'POST', '/api/v1/modules/community/posts/abc/comments')).toBe(
      'Comunidad',
    );
  });

  it('corta reaccionar', () => {
    expect(blockedBy(['community'], 'POST', '/api/v1/modules/community/reactions')).toBe(
      'Comunidad',
    );
  });

  it('corta la API externa, que publica en el feed sin pasar por JwtAuthGuard', () => {
    expect(blockedBy(['community'], 'POST', '/api/v1/community-api/posts')).toBe('Comunidad');
  });

  it('corta enviar un mensaje', () => {
    expect(
      blockedBy(['messaging'], 'POST', '/api/v1/modules/messaging/conversations/abc/messages'),
    ).toBe('Mensajes');
  });

  it('corta abrir un DM nuevo: si no puede escribir, no debe poder crear conversaciones', () => {
    expect(blockedBy(['messaging'], 'POST', '/api/v1/modules/messaging/dm')).toBe('Mensajes');
  });

  it('corta subir ficheros', () => {
    expect(blockedBy(['uploads'], 'POST', '/api/v1/storage/upload')).toBe('Subidas de archivos');
  });

  it('corta crear un recurso', () => {
    expect(blockedBy(['uploads'], 'POST', '/api/v1/modules/resources')).toBe('Subidas de archivos');
  });

  it('corta preguntar al tutor IA', () => {
    expect(blockedBy(['ai'], 'POST', '/api/v1/modules/ai-tutor/courses/abc/ask')).toBe('Tutor IA');
  });

  it('con "all" corta editar el perfil, que es donde se muda el spam', () => {
    expect(blockedBy(ALL, 'PATCH', '/api/v1/me/profile')).toBe('Toda la plataforma');
  });

  it('con "all" corta los comentarios de lección', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/learning/lessons/abc/comments')).toBe(
      'Toda la plataforma',
    );
  });

  it('con "all" corta las entregas de retos', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/gamification/challenges/abc/submit')).toBe(
      'Toda la plataforma',
    );
  });

  it('"all" cubre además todas las áreas concretas', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/community/posts')).toBe('Comunidad');
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/messaging/conversations/x/messages')).toBe(
      'Mensajes',
    );
    expect(blockedBy(ALL, 'POST', '/api/v1/storage/upload')).toBe('Subidas de archivos');
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/ai-tutor/courses/x/ask')).toBe('Tutor IA');
  });
});

describe('blockedBy — lo que NUNCA se bloquea', () => {
  it('deja pasar cualquier lectura, aunque esté sancionado de todo', () => {
    expect(blockedBy(ALL, 'GET', '/api/v1/modules/community/posts')).toBeNull();
    expect(blockedBy(ALL, 'GET', '/api/v1/modules/messaging/conversations')).toBeNull();
    expect(blockedBy(ALL, 'HEAD', '/api/v1/modules/community/posts')).toBeNull();
  });

  it('deja pagar: billing, suscripciones y conexiones de pago', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/billing/checkout')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/subscriptions/checkout')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/payment-connections/sync')).toBeNull();
  });

  it('deja inscribirse y matricularse', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/inscripcion/solicitud')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/learning/enrollments/me')).toBeNull();
  });

  it('deja seguir el curso que ya compró: progreso, SCORM y quizzes', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/learning/progress')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/learning/lessons/abc/scorm/attempt')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/assessments/attempts')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/assessments/attempts/abc/submit')).toBeNull();
  });

  it('deja gestionar su cuenta: contraseña, sesiones y avisos', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/auth/change-password')).toBeNull();
    expect(blockedBy(ALL, 'DELETE', '/api/v1/me/security/sessions/abc')).toBeNull();
    expect(blockedBy(ALL, 'PUT', '/api/v1/me/notification-preferences')).toBeNull();
  });

  it('deja marcar notificaciones como leídas', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/notifications/read-all')).toBeNull();
  });

  it('deja apuntarse a una clase en directo ya publicada', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/zoom-live/sessions/abc/register')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/zoom-live/sessions/abc/join')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/modules/events/abc/register')).toBeNull();
  });

  it('un silenciado en mensajes sigue leyendo: marcar leído y abrir el stream', () => {
    expect(
      blockedBy(['messaging'], 'POST', '/api/v1/modules/messaging/conversations/abc/read'),
    ).toBeNull();
    expect(blockedBy(['messaging'], 'POST', '/api/v1/modules/messaging/stream-ticket')).toBeNull();
  });

  it('deja darse de baja del digest aunque esté sancionado en comunidad', () => {
    expect(blockedBy(['community'], 'PUT', '/api/v1/modules/community/me/preferences')).toBeNull();
  });

  it('deja registrar la descarga de un recurso: es telemetría de lectura', () => {
    expect(blockedBy(['uploads'], 'POST', '/api/v1/modules/resources/abc/download')).toBeNull();
  });

  it('no toca las rutas de admin del tutor IA: sancionar a un formador no le deja sin reindexar', () => {
    expect(blockedBy(ALL, 'POST', '/api/v1/admin/ai-tutor/reindex-all')).toBeNull();
    expect(blockedBy(ALL, 'POST', '/api/v1/admin/ai-tutor/courses/abc/index')).toBeNull();
  });

  it('sin sanciones no bloquea nada', () => {
    expect(blockedBy([], 'POST', '/api/v1/modules/community/posts')).toBeNull();
  });
});

describe('blockedBy — aislamiento entre áreas', () => {
  it('una sanción de comunidad no toca los mensajes', () => {
    expect(
      blockedBy(['community'], 'POST', '/api/v1/modules/messaging/conversations/x/messages'),
    ).toBeNull();
  });

  it('una sanción de mensajes no toca la comunidad', () => {
    expect(blockedBy(['messaging'], 'POST', '/api/v1/modules/community/posts')).toBeNull();
  });

  it('una sanción de área concreta no arrastra las reglas exclusivas de "all"', () => {
    expect(blockedBy(['community'], 'PATCH', '/api/v1/me/profile')).toBeNull();
    expect(blockedBy(['messaging'], 'POST', '/api/v1/modules/surveys/abc/responses')).toBeNull();
  });

  it('varias áreas a la vez se acumulan', () => {
    const scopes = ['community', 'ai'];
    expect(blockedBy(scopes, 'POST', '/api/v1/modules/community/posts')).toBe('Comunidad');
    expect(blockedBy(scopes, 'POST', '/api/v1/modules/ai-tutor/courses/x/ask')).toBe('Tutor IA');
    expect(blockedBy(scopes, 'POST', '/api/v1/storage/upload')).toBeNull();
  });
});

describe('scopeLabels', () => {
  it('traduce las áreas concretas', () => {
    expect(scopeLabels(['community', 'ai'])).toEqual(['Comunidad', 'Tutor IA']);
  });

  it('el comodín se muestra como una sola etiqueta', () => {
    expect(scopeLabels(['all'])).toEqual(['Toda la plataforma']);
  });

  it('ignora áreas desconocidas en vez de romper la ficha', () => {
    expect(scopeLabels(['community', 'inventada'])).toEqual(['Comunidad']);
  });

  it('todas las áreas del catálogo tienen etiqueta', () => {
    for (const scope of CONTENT_SCOPES) {
      expect(scopeLabels([scope])).toHaveLength(1);
      expect(scopeLabels([scope])[0]).toBeTruthy();
    }
  });
});
