/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Recorrido 3 — capturas de los MÓDULOS para la documentación pública
 * (`didacta-docs/docs/modules/`). Escribe cada PNG en
 * `<out>/modulos/<modulo>/[en/]<nombre>.png`.
 *
 * Continúa donde terminan `01-recorrido-visual.spec.ts` y
 * `02-notificaciones-y-pagos.spec.ts` (orden alfabético, `workers: 1`): da por
 * hecho el tenant `academia-demo`, su admin y alumna, el curso de fotografía
 * publicado con la alumna graduada, el SMTP de Mailpit verificado y las claves
 * falsas de Stripe guardadas.
 *
 * Diseño a propósito distinto de los recorridos 1 y 2:
 *  - El estado se construye por API (fase ESTADO) y cada bloque va en
 *    try/catch: un módulo que falle no tira la tanda, solo deja sus capturas
 *    sin estado y un aviso en consola.
 *  - Cada captura también va en try/catch: se salta con `console.warn` y el
 *    resto sigue. Al final se imprime el resumen de tomadas/saltadas.
 *  - Las capturas que exigen servicios reales (clave de IA con embeddings,
 *    cuenta Stripe de verdad, checkout completado, RLPT de Fundae, un segundo
 *    alumno para la bandeja de consultas del staff…) quedan FUERA; están
 *    anotadas una a una al final del fichero.
 */

import { expect, test } from '@playwright/test';
import { encodePng } from '../helpers/png';
import { newShotContext, newShotPage } from './lib/browser';
import {
  api,
  completeAcademyOnboarding,
  injectSession,
  mailpitClear,
  mailpitWaitFor,
  setProfileLocale,
  signin,
} from './lib/api';
import { DEMO, LOCALE } from './lib/config';
import { t } from './lib/i18n';
import { assertLocale, shot, type Walkthrough } from './lib/shot';

// ─────────────────────────────────────────────────────────────────────────────
// Datos de demostración de los módulos. Misma regla whitelabel que `config.ts`:
// dominios reservados y nombres genéricos. Son constantes locales de este spec
// para no tocar los datos que los recorridos 1 y 2 ya retratan.
// ─────────────────────────────────────────────────────────────────────────────

const X = {
  categorias: [
    { name: 'Fotografía', color: '#2E7DCE', icon: 'sparkles' },
    { name: 'Edición', color: '#7C3AED', icon: 'book' },
    { name: 'Negocio', color: '#0F766E', icon: 'award' },
  ],
  cursoEdicion: {
    titulo: 'Edición de fotografía con Lightroom',
    slug: 'edicion-fotografia-lightroom',
    categoria: 'Edición',
    descripcion:
      'Del carrete digital a la foto final: organiza tu catálogo, revela con criterio y exporta para web e impresión.',
    modulo: 'Flujo de trabajo',
    lecciones: [
      'Importar y organizar el catálogo',
      'Revelado básico: luz y color',
      'Exportar para web e impresión',
    ],
    textoLeccion:
      'En esta lección montamos el flujo de trabajo completo: importar, marcar las mejores tomas y dejar el catálogo listo para revelar sin perder tiempo.',
  },
  cursoMarketing: {
    titulo: 'Marketing para fotógrafos',
    slug: 'marketing-para-fotografos',
    categoria: 'Negocio',
    descripcion:
      'Convierte tu afición en encargos: marca personal, porfolio y tus tres primeros clientes.',
    modulos: [
      {
        titulo: 'Tu marca personal',
        lecciones: ['Define tu propuesta', 'Tu porfolio en una tarde'],
      },
      { titulo: 'Conseguir clientes', lecciones: ['El primer encargo'] },
    ],
  },
  cursoArchivado: {
    titulo: 'Iluminación de estudio (edición 2025)',
    slug: 'iluminacion-estudio-2025',
    categoria: 'Fotografía',
    leccion: 'Esquema de una luz',
  },
  quiz: {
    leccion: 'Repaso: fundamentos de fotografía',
    titulo: 'Repaso de fundamentos',
    descripcion: 'Cuatro preguntas cortas para afianzar lo esencial antes de seguir.',
    single: {
      prompt: '¿Qué controla la apertura del diafragma?',
      opciones: ['La profundidad de campo', 'La sensibilidad del sensor', 'El balance de blancos'],
    },
    vf: { prompt: 'Un ISO alto siempre produce más ruido en la imagen.' },
    hueco: {
      prompt: 'La regla compositiva que divide el encuadre en nueve partes es la regla de los ___.',
      respuesta: 'tercios',
    },
    abierta: {
      prompt: 'Describe cómo harías un retrato con luz natural una tarde nublada.',
      respuesta:
        'Buscaría una ventana orientada al norte para tener luz suave y constante, colocaría a la persona en un ángulo de 45 grados y usaría un reflector casero para levantar las sombras.',
    },
  },
  tiers: ['Free', 'Básico', 'Pro'],
  grupoAvanzado: 'Fotografía avanzada',
  plantillas: {
    clasica: {
      nombre: 'Diploma clásico',
      cuerpo:
        'Certificamos que {{alumno}} ha completado con aprovechamiento el curso {{curso}} con fecha {{fecha}}. Certificado nº {{numero}}.',
      color: '#1E5AA8',
    },
    firmada: {
      nombre: 'Diploma con firma',
      cuerpo:
        '{{alumno}} ha superado el programa {{curso}}. Expedido el {{fecha}} con el número {{numero}}.',
      color: '#0F766E',
      firmante: 'Admin Demo',
      cargo: 'Dirección académica',
    },
  },
  tag: { nombre: 'Fotografía', color: '#2E7DCE', icon: 'sparkles' },
  posts: {
    bienvenida: {
      titulo: 'Bienvenida a la comunidad de Academia Demo',
      cuerpo:
        'Este es nuestro espacio para compartir avances, dudas y recursos. Preséntate cuando quieras y cuéntanos qué te gustaría aprender.',
    },
    camara: {
      titulo: '¿Qué cámara me recomendáis para empezar?',
      cuerpo:
        'Estoy entre una réflex de segunda mano y una mirrorless básica. Mi presupuesto ronda los 500 €. ¿Qué priorizaríais?',
    },
    retrato: {
      titulo: 'Mi primer retrato en exteriores',
      cuerpo:
        'Apliqué lo de la lección de luz natural y salió esto. Acepto críticas constructivas, ¡sobre todo del encuadre!',
    },
    comentario: 'Para empezar, cualquiera de las dos: invierte en un buen objetivo fijo.',
  },
  composer: {
    titulo: 'Cambio de aula para la clase del jueves',
    cuerpo: 'La clase en directo del jueves pasa a las 18:30. Os llegará también por correo.',
  },
  espacio: {
    slug: 'proyectos',
    titulo: 'Proyectos',
    descripcion: 'Retos y trabajos en curso de la academia.',
  },
  aviso: {
    asunto: 'Nueva clase en directo este jueves',
    cuerpo:
      'Este jueves a las 18:00 revisamos porfolios en directo. Trae tus tres mejores fotos y las comentamos entre todos.',
  },
  planAnual: { nombre: 'Membresía anual', meses: 12, importeCents: 19000, tachadoCents: 22800 },
  recursos: [
    {
      kind: 'LINK',
      titulo: 'Guía rápida de composición',
      url: 'https://example.com/guia-composicion',
    },
    {
      kind: 'LINK',
      titulo: 'Tabla de aperturas y velocidades',
      url: 'https://example.com/tabla-exposicion',
    },
    {
      kind: 'FILE',
      titulo: 'Checklist de sesión en exteriores',
      url: 'https://example.com/checklist-exteriores.pdf',
      fileName: 'checklist-exteriores.pdf',
    },
    {
      kind: 'LINK',
      titulo: 'Presets de revelado de la academia',
      url: 'https://example.com/presets-revelado',
    },
  ],
  coleccionNueva: {
    titulo: 'Recetas de edición',
    descripcion: 'Ajustes paso a paso para clonar el estilo de la academia.',
  },
  recursoModal: {
    titulo: 'Checklist de viaje fotográfico',
    descripcion: 'Qué meter en la mochila para no cargar de más.',
  },
  clase: {
    tema: 'Clase en directo: revisión de porfolios',
    descripcion:
      'Traed vuestras tres mejores fotos: las comentamos en directo y elegimos la de la semana.',
    duracionMin: 60,
  },
  fundae: {
    accion: {
      codigo: 'AF-2026-001',
      nombre: 'Fotografía digital — iniciación bonificada',
      horas: 20,
      inicio: '2026-09-01',
      fin: '2026-09-30',
    },
    bloques: [
      {
        ordinal: 1,
        titulo: 'Fundamentos de cámara',
        horas: 10,
        contenidos: 'Exposición, enfoque y modos de disparo.',
      },
      {
        ordinal: 2,
        titulo: 'Composición y luz',
        horas: 10,
        contenidos: 'Regla de los tercios, luz natural y retrato.',
      },
    ],
    empresa: {
      nif: 'B12345678',
      razonSocial: 'Estudio Luz y Foco SL',
      plantilla: 14,
      creditoCents: 120000,
    },
    grupo: { numero: 1, creditoCents: 42000 },
  },
  niveles: [
    {
      key: 'aprendiz',
      nombre: 'Aprendiz',
      minPoints: 0,
      beneficio: 'Acceso a los retos mensuales',
    },
    {
      key: 'experta',
      nombre: 'Experta',
      minPoints: 50,
      beneficio: 'Sesión de porfolio 1:1 al trimestre',
    },
  ],
  retos: [
    {
      titulo: 'Comparte tu mejor foto de la semana',
      puntos: 25,
      prueba: true,
      descripcion: 'Sube tu mejor toma de esta semana y cuenta cómo la hiciste.',
    },
    {
      titulo: 'Preséntate a la comunidad',
      puntos: 10,
      prueba: false,
      descripcion: 'Un post corto en el feed basta.',
    },
  ],
  entrega: {
    proofUrl: 'https://example.com/mi-mejor-foto.jpg',
    proofName: 'mi-mejor-foto.jpg',
    nota: 'Retrato con luz de ventana, aplicando la lección 1.',
  },
  mensajes: {
    alumna1: 'Hola, ¿podríais revisar el encuadre de mi ejercicio de la lección 1?',
    alumna2: '¿Hay tutoría esta semana?',
    profe: 'Claro, lo vemos juntos en la clase del jueves y te paso notas.',
    dm: 'Bienvenida al aula. Cualquier duda me escribes por aquí.',
  },
  wpSso: {
    secreto: 'demo-wp-sso-secret-0123456789abcdef0123456789abcdef',
    homeUrl: 'https://academia-demo-wp.example.com',
  },
  registro: {
    botUsername: 'academia_demo_bot',
    groupId: '-1001234567890',
    botToken: '1234567890:AA-token-de-demo-no-real',
  },
  aspirante: {
    nombre: 'Aspirante Demo',
    email: 'aspirante@example.com',
    password: 'AspiranteDemo2026!',
  },
  tema: {
    hue: 292,
    headline: 'Aprende fotografía con nosotros',
    subheadline: 'Accede a tus cursos, clases en directo y comunidad.',
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos mínimos de las respuestas de la API que este spec consume. Son espejo
// de los clients reales de `apps/web/src/lib/*` y `apps/web/src/modules/*`.
// ─────────────────────────────────────────────────────────────────────────────

interface CursoApi {
  id: string;
  slug: string;
  title: string;
  status: string;
}
interface CursoDetalleApi extends CursoApi {
  modules: Array<{
    id: string;
    title: string;
    lessons: Array<{ id: string; title: string; type: string }>;
  }>;
}
interface MatriculaApi {
  id: string;
  courseId: string;
}
interface GrupoAccesoApi {
  id: string;
  name: string;
}
interface PreguntaAlumnoApi {
  id: string;
  type: string;
  options: Array<{ id: string }>;
}
interface IntentoApi {
  id: string;
  status: string;
}

/** Escapa un literal para usarlo dentro de un RegExp de Playwright. */
function reEscape(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** Degradado en memoria, como en el recorrido 1: cero binarios en el repo. */
function gradientPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = 46 + Math.round((x * 80) / width);
      raw[i + 1] = 125 + Math.round((y * 60) / height);
      raw[i + 2] = 206;
      raw[i + 3] = 255;
    }
  }
  return encodePng(raw, width, height);
}

/** Sondea `fn` hasta que devuelva algo o venza el plazo (para envíos asíncronos). */
async function esperarA<T>(fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

test('modulos · capturas', async ({ browser }) => {
  // 70+ capturas y toda la fase de estado: presupuesto propio por encima del
  // default del config (20 min).
  test.setTimeout(30 * 60 * 1000);

  const saltadas: string[] = [];
  let tomadas = 0;

  /** Una captura fallida avisa y NO tira la tanda. */
  async function captura(modulo: string, nombre: string, toma: () => Promise<void>): Promise<void> {
    try {
      await toma();
      tomadas += 1;
    } catch (e) {
      saltadas.push(`${modulo}/${nombre}`);
      console.warn(
        `[modulos] captura saltada ${modulo}/${nombre}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Un bloque de estado fallido avisa y deja que el resto siga. */
  async function estado(nombre: string, prepara: () => Promise<void>): Promise<void> {
    try {
      await prepara();
    } catch (e) {
      console.warn(`[modulos] sin estado ${nombre}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function walk(modulo: string): Walkthrough {
    return `modulos/${modulo}`;
  }

  // ───────────────────────────────────────────────────────── contextos ──
  const adminCtx = await newShotContext(browser);
  const admin = await newShotPage(adminCtx);
  const adminSesion = await signin({
    tenantSlug: DEMO.org.slug,
    email: DEMO.admin.email,
    password: DEMO.admin.password,
  });
  const adminTok = adminSesion.tokens.accessToken;
  const adminId = adminSesion.user.id;
  await setProfileLocale(adminTok);
  await admin.goto('/signin');
  await injectSession(admin, {
    accessToken: adminTok,
    refreshToken: adminSesion.tokens.refreshToken,
    user: { ...adminSesion.user, onboardingCompletedAt: new Date().toISOString() },
  });

  const alumnaCtx = await newShotContext(browser);
  const alumna = await newShotPage(alumnaCtx);
  const alumnaSesion = await signin({
    tenantSlug: DEMO.org.slug,
    email: DEMO.alumna.email,
    password: DEMO.alumna.password,
  });
  const alumnaTok = alumnaSesion.tokens.accessToken;
  const alumnaId = alumnaSesion.user.id;
  await setProfileLocale(alumnaTok);
  await alumna.goto('/signin');
  await injectSession(alumna, {
    accessToken: alumnaTok,
    refreshToken: alumnaSesion.tokens.refreshToken,
    user: { ...alumnaSesion.user, onboardingCompletedAt: new Date().toISOString() },
  });

  const publicCtx = await newShotContext(browser);
  const publicPage = await newShotPage(publicCtx);

  // Estado compartido entre bloques (queda undefined si su bloque falló).
  let cursoDemo: CursoApi | undefined;
  let cursoEdicion: CursoApi | undefined;
  let cursoMarketing: CursoApi | undefined;
  let quizId: string | undefined;
  let grupoCompletoId: string | undefined;
  let grupoAvanzadoId: string | undefined;
  let coleccionRecursosId: string | undefined;
  let sesionZoomId: string | undefined;
  let accionFundaeId: string | undefined;
  let certificadoId: string | undefined;
  let mensajeParaClicar: string | undefined;

  /** Cursos del formador con un slug dado (para que el spec sea re-ejecutable). */
  async function cursoPorSlug(slug: string): Promise<CursoApi | undefined> {
    const cursos = await api<CursoApi[]>('/api/v1/modules/courses', { bearer: adminTok });
    return cursos.find((c) => c.slug === slug);
  }

  // ════════════════════════════════════════════════════ FASE DE ESTADO ══

  await estado('categorías curadas', async () => {
    for (const cat of X.categorias) {
      // Conflicto (ya existe) = no-op: el nombre es único por tenant.
      await api('/api/v1/modules/courses/managed-categories', {
        method: 'POST',
        body: cat,
        bearer: adminTok,
      }).catch(() => undefined);
    }
  });

  await estado('curso demo localizado', async () => {
    cursoDemo = await cursoPorSlug(DEMO.course.slug);
    if (!cursoDemo)
      throw new Error(`no existe el curso ${DEMO.course.slug} (¿corrió el recorrido 1?)`);
  });

  await estado('curso extra publicado (edición)', async () => {
    cursoEdicion = await cursoPorSlug(X.cursoEdicion.slug);
    if (!cursoEdicion) {
      cursoEdicion = await api<CursoApi>('/api/v1/modules/courses', {
        method: 'POST',
        body: {
          slug: X.cursoEdicion.slug,
          title: X.cursoEdicion.titulo,
          description: X.cursoEdicion.descripcion,
          category: X.cursoEdicion.categoria,
          estimatedMinutes: 90,
        },
        bearer: adminTok,
      });
      const mod = await api<{ id: string }>(`/api/v1/modules/courses/${cursoEdicion.id}/modules`, {
        method: 'POST',
        body: { title: X.cursoEdicion.modulo },
        bearer: adminTok,
      });
      for (const titulo of X.cursoEdicion.lecciones) {
        const leccion = await api<{ id: string }>(
          `/api/v1/modules/courses/modules/${mod.id}/lessons`,
          {
            method: 'POST',
            body: { type: 'TEXT', title: titulo },
            bearer: adminTok,
          },
        );
        await api(`/api/v1/modules/courses/lessons/${leccion.id}`, {
          method: 'PUT',
          body: { content: { text: X.cursoEdicion.textoLeccion }, durationMinutes: 20 },
          bearer: adminTok,
        });
      }
      await api(`/api/v1/modules/courses/${cursoEdicion.id}/publish`, {
        method: 'POST',
        body: {},
        bearer: adminTok,
      });
    }
  });

  await estado('curso extra en borrador (marketing)', async () => {
    cursoMarketing = await cursoPorSlug(X.cursoMarketing.slug);
    if (!cursoMarketing) {
      cursoMarketing = await api<CursoApi>('/api/v1/modules/courses', {
        method: 'POST',
        body: {
          slug: X.cursoMarketing.slug,
          title: X.cursoMarketing.titulo,
          description: X.cursoMarketing.descripcion,
          category: X.cursoMarketing.categoria,
        },
        bearer: adminTok,
      });
      for (const modulo of X.cursoMarketing.modulos) {
        const mod = await api<{ id: string }>(
          `/api/v1/modules/courses/${cursoMarketing.id}/modules`,
          {
            method: 'POST',
            body: { title: modulo.titulo },
            bearer: adminTok,
          },
        );
        for (const [i, titulo] of modulo.lecciones.entries()) {
          // Tipos variados a propósito: la captura del builder los enseña.
          await api(`/api/v1/modules/courses/modules/${mod.id}/lessons`, {
            method: 'POST',
            body: { type: i % 2 === 0 ? 'TEXT' : 'VIDEO', title: titulo },
            bearer: adminTok,
          });
        }
      }
      // Se queda en DRAFT: es lo que retrata la captura del builder.
    }
  });

  await estado('curso archivado', async () => {
    let archivado = await cursoPorSlug(X.cursoArchivado.slug);
    if (!archivado) {
      archivado = await api<CursoApi>('/api/v1/modules/courses', {
        method: 'POST',
        body: {
          slug: X.cursoArchivado.slug,
          title: X.cursoArchivado.titulo,
          category: X.cursoArchivado.categoria,
        },
        bearer: adminTok,
      });
      const mod = await api<{ id: string }>(`/api/v1/modules/courses/${archivado.id}/modules`, {
        method: 'POST',
        body: { title: X.cursoArchivado.leccion },
        bearer: adminTok,
      });
      const leccion = await api<{ id: string }>(
        `/api/v1/modules/courses/modules/${mod.id}/lessons`,
        {
          method: 'POST',
          body: { type: 'TEXT', title: X.cursoArchivado.leccion },
          bearer: adminTok,
        },
      );
      await api(`/api/v1/modules/courses/lessons/${leccion.id}`, {
        method: 'PUT',
        body: { content: { text: 'Material de la edición anterior.' }, durationMinutes: 10 },
        bearer: adminTok,
      });
      await api(`/api/v1/modules/courses/${archivado.id}/publish`, {
        method: 'POST',
        body: {},
        bearer: adminTok,
      });
      await api(`/api/v1/modules/courses/${archivado.id}/archive`, {
        method: 'POST',
        body: {},
        bearer: adminTok,
      });
    }
  });

  await estado('matrículas y progreso', async () => {
    if (!cursoEdicion || !cursoDemo) throw new Error('faltan los cursos');
    // La alumna en el curso de edición, con la primera lección completada
    // (~33%): así la ficha del alumno enseña progreso parcial y el listado del
    // formador tiene datos.
    await api('/api/v1/modules/learning/enrollments', {
      method: 'POST',
      body: { userId: alumnaId, courseId: cursoEdicion.id },
      bearer: adminTok,
    }).catch(() => undefined);
    // El admin también se matricula en el curso demo: el listado de alumnos
    // del formador gana una segunda fila con estado distinto.
    await api('/api/v1/modules/learning/enrollments', {
      method: 'POST',
      body: { userId: adminId, courseId: cursoDemo.id },
      bearer: adminTok,
    }).catch(() => undefined);

    const matriculas = await api<MatriculaApi[]>('/api/v1/modules/learning/me/enrollments', {
      bearer: alumnaTok,
    });
    const matricula = matriculas.find((m) => m.courseId === cursoEdicion!.id);
    if (matricula) {
      const detalle = await api<CursoDetalleApi>(`/api/v1/modules/courses/${cursoEdicion.id}`, {
        bearer: alumnaTok,
      });
      const primera = detalle.modules[0]?.lessons[0];
      if (primera) {
        await api('/api/v1/modules/learning/progress', {
          method: 'POST',
          body: {
            enrollmentId: matricula.id,
            lessonId: primera.id,
            watchedSeconds: 300,
            completed: true,
          },
          bearer: alumnaTok,
        });
      }
    }
  });

  await estado('quiz con 4 preguntas en el curso demo', async () => {
    if (!cursoDemo) throw new Error('falta el curso demo');
    const detalle = await api<CursoDetalleApi>(`/api/v1/modules/courses/${cursoDemo.id}`, {
      bearer: adminTok,
    });
    const moduloDemo = detalle.modules[0];
    if (!moduloDemo) throw new Error('el curso demo no tiene secciones');
    let leccionQuiz = detalle.modules
      .flatMap((m) => m.lessons)
      .find((l) => l.title === X.quiz.leccion);
    if (!leccionQuiz) {
      leccionQuiz = await api<{ id: string; title: string; type: string }>(
        `/api/v1/modules/courses/modules/${moduloDemo.id}/lessons`,
        { method: 'POST', body: { type: 'QUIZ', title: X.quiz.leccion }, bearer: adminTok },
      );
    }
    // No hay listado de quizzes en el client: si la lección ya existía de una
    // tanda anterior el quiz también, pero sin su id no se puede recuperar.
    // En la tanda normal (instancia recién sembrada) este camino no se da.
    const quiz = await api<{ id: string }>('/api/v1/modules/assessments/quizzes', {
      method: 'POST',
      body: {
        lessonId: leccionQuiz.id,
        title: X.quiz.titulo,
        description: X.quiz.descripcion,
        passThreshold: 60,
      },
      bearer: adminTok,
    });
    quizId = quiz.id;
    await api(`/api/v1/modules/assessments/quizzes/${quizId}/questions`, {
      method: 'POST',
      body: {
        type: 'SINGLE_CHOICE',
        prompt: X.quiz.single.prompt,
        points: 2,
        options: X.quiz.single.opciones.map((label, i) => ({ label, isCorrect: i === 0 })),
      },
      bearer: adminTok,
    });
    await api(`/api/v1/modules/assessments/quizzes/${quizId}/questions`, {
      method: 'POST',
      body: {
        type: 'TRUE_FALSE',
        prompt: X.quiz.vf.prompt,
        points: 1,
        options: [
          { label: 'Verdadero', isCorrect: true },
          { label: 'Falso', isCorrect: false },
        ],
      },
      bearer: adminTok,
    });
    await api(`/api/v1/modules/assessments/quizzes/${quizId}/questions`, {
      method: 'POST',
      body: {
        type: 'FILL_IN_BLANK',
        prompt: X.quiz.hueco.prompt,
        points: 1,
        acceptedAnswers: [X.quiz.hueco.respuesta],
      },
      bearer: adminTok,
    });
    await api(`/api/v1/modules/assessments/quizzes/${quizId}/questions`, {
      method: 'POST',
      body: { type: 'LONG_ANSWER', prompt: X.quiz.abierta.prompt, points: 4 },
      bearer: adminTok,
    });
    await api(`/api/v1/modules/assessments/quizzes/${quizId}/publish`, {
      method: 'POST',
      body: {},
      bearer: adminTok,
    });
  });

  await estado('tiers y grupos de acceso', async () => {
    for (const [i, nombre] of X.tiers.entries()) {
      await api('/api/v1/modules/payment-connections/tiers/catalog', {
        method: 'POST',
        body: { name: nombre, isFree: nombre === 'Free', sortOrder: i },
        bearer: adminTok,
      }).catch(() => undefined);
    }
    const lista = await api<{ groups: GrupoAccesoApi[] }>(
      '/api/v1/modules/access-groups?page=1&limit=50',
      {
        bearer: adminTok,
      },
    );
    grupoCompletoId = lista.groups.find((g) => g.name === DEMO.accessGroup.name)?.id;
    grupoAvanzadoId = lista.groups.find((g) => g.name === X.grupoAvanzado)?.id;
    if (!grupoAvanzadoId && cursoDemo && cursoEdicion) {
      const creado = await api<{ id: string }>('/api/v1/modules/access-groups', {
        method: 'POST',
        body: {
          name: X.grupoAvanzado,
          kind: 'MULTI_COURSE',
          description: 'Cursos de nivel intermedio y talleres.',
          courseIds: [cursoDemo.id, cursoEdicion.id],
        },
        bearer: adminTok,
      });
      grupoAvanzadoId = creado.id;
    }
    if (grupoAvanzadoId) {
      // El vínculo con un tier de mod.payment-connections pinta el badge
      // «Tier: Pro» del listado.
      await api(`/api/v1/modules/access-groups/${grupoAvanzadoId}`, {
        method: 'PATCH',
        body: { linkedTierName: 'Pro' },
        bearer: adminTok,
      }).catch(() => undefined);
      await api(`/api/v1/modules/access-groups/${grupoAvanzadoId}/members`, {
        method: 'POST',
        body: { userIds: [alumnaId] },
        bearer: adminTok,
      }).catch(() => undefined);
    }
    if (grupoCompletoId) {
      await api(`/api/v1/modules/access-groups/${grupoCompletoId}`, {
        method: 'PATCH',
        body: { isDefaultForApproval: true, autoGrantNewCourses: true },
        bearer: adminTok,
      }).catch(() => undefined);
      await api(`/api/v1/modules/access-groups/${grupoCompletoId}/members`, {
        method: 'POST',
        body: { userIds: [alumnaId] },
        bearer: adminTok,
      }).catch(() => undefined);
    }
  });

  await estado('drip en el curso de edición', async () => {
    if (!cursoEdicion || !grupoCompletoId) throw new Error('faltan curso o grupo');
    const existentes = await api<Array<{ id: string }>>(
      `/api/v1/modules/learning/courses/${cursoEdicion.id}/drip`,
      { bearer: adminTok },
    );
    if (existentes.length === 0) {
      await api(`/api/v1/modules/learning/courses/${cursoEdicion.id}/drip`, {
        method: 'POST',
        body: {
          audienceKind: 'GROUP',
          audienceRef: grupoCompletoId,
          unit: 'LESSON',
          intervalDays: 7,
        },
        bearer: adminTok,
      });
    }
  });

  await estado('segunda invitación del curso demo', async () => {
    if (!cursoDemo) throw new Error('falta el curso demo');
    const invitaciones = await api<Array<{ id: string }>>(
      `/api/v1/modules/learning/invitations?courseId=${cursoDemo.id}`,
      { bearer: adminTok },
    );
    // La primera la generó el recorrido 1 por la interfaz; con dos el listado
    // de la captura no parece un caso de laboratorio.
    if (invitaciones.length < 2) {
      await api('/api/v1/modules/learning/invitations', {
        method: 'POST',
        body: { courseId: cursoDemo.id, maxUses: 5 },
        bearer: adminTok,
      });
    }
  });

  await estado('plantillas de certificado', async () => {
    const plantillas = await api<Array<{ id: string; name: string }>>(
      '/api/v1/modules/certificates/templates',
      {
        bearer: adminTok,
      },
    );
    if (!plantillas.some((p) => p.name === X.plantillas.clasica.nombre)) {
      await api('/api/v1/modules/certificates/templates', {
        method: 'POST',
        body: {
          name: X.plantillas.clasica.nombre,
          body: X.plantillas.clasica.cuerpo,
          primaryColor: X.plantillas.clasica.color,
          isDefault: true,
        },
        bearer: adminTok,
      });
    }
    if (!plantillas.some((p) => p.name === X.plantillas.firmada.nombre)) {
      await api('/api/v1/modules/certificates/templates', {
        method: 'POST',
        body: {
          name: X.plantillas.firmada.nombre,
          body: X.plantillas.firmada.cuerpo,
          primaryColor: X.plantillas.firmada.color,
          signerName: X.plantillas.firmada.firmante,
          signerTitle: X.plantillas.firmada.cargo,
        },
        bearer: adminTok,
      });
    }
  });

  await estado('certificado de la alumna localizado', async () => {
    const certificados = await api<Array<{ id: string }>>('/api/v1/modules/certificates/me', {
      bearer: alumnaTok,
    });
    certificadoId = certificados[0]?.id;
    if (!certificadoId) throw new Error('la alumna no tiene certificado (¿corrió el recorrido 1?)');
  });

  await estado('comunidad: tag, posts, reacciones y espacio propio', async () => {
    await api('/api/v1/modules/community/tags', {
      method: 'POST',
      body: { name: X.tag.nombre, color: X.tag.color, icon: X.tag.icon },
      bearer: adminTok,
    }).catch(() => undefined);

    const posts = await api<Array<{ id: string; title: string }>>(
      '/api/v1/modules/community/posts?limit=50',
      {
        bearer: adminTok,
      },
    );
    const porTitulo = new Map(posts.map((p) => [p.title, p.id]));

    let bienvenidaId = porTitulo.get(X.posts.bienvenida.titulo);
    if (!bienvenidaId) {
      const post = await api<{ id: string }>('/api/v1/modules/community/posts', {
        method: 'POST',
        body: { title: X.posts.bienvenida.titulo, body: X.posts.bienvenida.cuerpo },
        bearer: adminTok,
      });
      bienvenidaId = post.id;
    }
    await api(`/api/v1/modules/community/posts/${bienvenidaId}/pin`, {
      method: 'POST',
      body: {},
      bearer: adminTok,
    }).catch(() => undefined);

    let camaraId = porTitulo.get(X.posts.camara.titulo);
    if (!camaraId) {
      const post = await api<{ id: string }>('/api/v1/modules/community/posts', {
        method: 'POST',
        body: { title: X.posts.camara.titulo, body: X.posts.camara.cuerpo, tags: [X.tag.nombre] },
        bearer: alumnaTok,
      });
      camaraId = post.id;
      await api(`/api/v1/modules/community/posts/${camaraId}/comments`, {
        method: 'POST',
        body: { body: X.posts.comentario },
        bearer: adminTok,
      });
    }
    if (!porTitulo.has(X.posts.retrato.titulo)) {
      const post = await api<{ id: string }>('/api/v1/modules/community/posts', {
        method: 'POST',
        body: { title: X.posts.retrato.titulo, body: X.posts.retrato.cuerpo, tags: [X.tag.nombre] },
        bearer: alumnaTok,
      });
      await api('/api/v1/modules/community/reactions', {
        method: 'POST',
        body: { postId: post.id, emoji: '👏' },
        bearer: adminTok,
      }).catch(() => undefined);
    }
    await api('/api/v1/modules/community/reactions', {
      method: 'POST',
      body: { postId: bienvenidaId, emoji: '❤️' },
      bearer: alumnaTok,
    }).catch(() => undefined);

    await api('/api/v1/modules/community/spaces', {
      method: 'POST',
      body: {
        slug: X.espacio.slug,
        title: X.espacio.titulo,
        description: X.espacio.descripcion,
        icon: 'sparkles',
      },
      bearer: adminTok,
    }).catch(() => undefined);
  });

  await estado('aviso masivo enviado (broadcast)', async () => {
    const avisos = await api<Array<{ id: string; status: string; subject: string }>>(
      '/api/v1/modules/community/broadcasts',
      { bearer: adminTok },
    );
    if (!avisos.some((b) => b.subject === X.aviso.asunto)) {
      // El SMTP del tenant apunta al Mailpit del stack (lo dejó el recorrido
      // 2), así que el envío es real y el historial acaba en DONE.
      await api('/api/v1/modules/community/broadcasts', {
        method: 'POST',
        body: { subject: X.aviso.asunto, bodyText: X.aviso.cuerpo },
        bearer: adminTok,
      });
    }
    const done = await esperarA(async () => {
      const lista = await api<Array<{ status: string; subject: string }>>(
        '/api/v1/modules/community/broadcasts',
        {
          bearer: adminTok,
        },
      );
      return lista.find((b) => b.subject === X.aviso.asunto && b.status === 'DONE') ?? null;
    });
    if (!done) throw new Error('el broadcast no llegó a DONE en 60 s');
  });

  await estado('programa de referidos activado', async () => {
    await api('/api/v1/modules/referrals/admin/config', {
      method: 'PUT',
      body: { active: true },
      bearer: adminTok,
    });
  });

  await estado('plan anual de membresía', async () => {
    const planes = await api<{ plans: Array<{ name: string }> }>('/api/v1/membership/admin/plans', {
      bearer: adminTok,
    });
    if (!planes.plans.some((p) => p.name === X.planAnual.nombre)) {
      await api('/api/v1/membership/admin/plans', {
        method: 'POST',
        body: {
          name: X.planAnual.nombre,
          intervalMonths: X.planAnual.meses,
          amountCents: X.planAnual.importeCents,
          compareAtCents: X.planAnual.tachadoCents,
          trialDays: 7,
          sortOrder: 2,
        },
        bearer: adminTok,
      });
    }
  });

  await estado('biblioteca de recursos', async () => {
    // El primer listado siembra las colecciones por defecto del tenant.
    const colecciones = await api<{
      collections: Array<{ id: string; title: string; resourceCount: number }>;
    }>('/api/v1/modules/resources/collections', { bearer: alumnaTok });
    const destino = colecciones.collections[0];
    if (!destino) throw new Error('no hay colecciones');
    coleccionRecursosId = destino.id;
    if (destino.resourceCount < X.recursos.length) {
      const creados: string[] = [];
      for (const r of X.recursos) {
        const recurso = await api<{ id: string }>('/api/v1/modules/resources', {
          method: 'POST',
          body: {
            collectionId: destino.id,
            kind: r.kind,
            title: r.titulo,
            url: r.url,
            ...('fileName' in r ? { fileName: r.fileName } : {}),
          },
          bearer: alumnaTok,
        });
        creados.push(recurso.id);
      }
      // Un par de descargas para que el contador no diga siempre 0.
      for (const id of creados.slice(0, 2)) {
        await api(`/api/v1/modules/resources/${id}/download`, {
          method: 'POST',
          body: {},
          bearer: alumnaTok,
        });
      }
      const primero = creados[0];
      if (primero) {
        await api(`/api/v1/modules/resources/${primero}/download`, {
          method: 'POST',
          body: {},
          bearer: adminTok,
        });
      }
    }
  });

  await estado('clase en directo (stub de Zoom)', async () => {
    const sesiones = await api<Array<{ id: string; topic: string }>>(
      '/api/v1/modules/zoom-live/sessions',
      {
        bearer: adminTok,
      },
    );
    sesionZoomId = sesiones.find((s) => s.topic === X.clase.tema)?.id;
    if (!sesionZoomId) {
      const inicio = new Date(Date.now() + 24 * 60 * 60 * 1000);
      inicio.setMinutes(0, 0, 0);
      const sesion = await api<{ id: string }>('/api/v1/modules/zoom-live/sessions', {
        method: 'POST',
        body: {
          topic: X.clase.tema,
          description: X.clase.descripcion,
          courseId: cursoDemo?.id ?? null,
          startTime: inicio.toISOString(),
          durationMinutes: X.clase.duracionMin,
          hostEmail: DEMO.admin.email,
          timezone: 'Europe/Madrid',
        },
        bearer: adminTok,
      });
      sesionZoomId = sesion.id;
    }
  });

  await estado('acción formativa Fundae', async () => {
    const acciones = await api<Array<{ id: string; codigoAccion: string }>>(
      '/api/v1/modules/fundae/actions',
      {
        bearer: adminTok,
      },
    );
    accionFundaeId = acciones.find((a) => a.codigoAccion === X.fundae.accion.codigo)?.id;
    if (!accionFundaeId) {
      const accion = await api<{ id: string }>('/api/v1/modules/fundae/actions', {
        method: 'POST',
        body: {
          codigoAccion: X.fundae.accion.codigo,
          nombre: X.fundae.accion.nombre,
          modalidad: 'TELEFORMACION',
          horasFormacion: X.fundae.accion.horas,
          fechaInicio: X.fundae.accion.inicio,
          fechaFin: X.fundae.accion.fin,
          courseId: cursoDemo?.id ?? null,
        },
        bearer: adminTok,
      });
      accionFundaeId = accion.id;
      for (const bloque of X.fundae.bloques) {
        await api(`/api/v1/modules/fundae/actions/${accionFundaeId}/blocks`, {
          method: 'POST',
          body: {
            ordinal: bloque.ordinal,
            title: bloque.titulo,
            hours: bloque.horas,
            modalidad: 'TELEFORMACION',
            contenidos: bloque.contenidos,
          },
          bearer: adminTok,
        });
      }
    }
  });

  await estado('empresa y grupo bonificable Fundae', async () => {
    if (!accionFundaeId) throw new Error('falta la acción formativa');
    const empresas = await api<Array<{ id: string; nif: string }>>(
      '/api/v1/admin/fundae/companies',
      {
        bearer: adminTok,
      },
    );
    let empresaId = empresas.find((e) => e.nif === X.fundae.empresa.nif)?.id;
    if (!empresaId) {
      const empresa = await api<{ id: string }>('/api/v1/admin/fundae/companies', {
        method: 'POST',
        body: {
          nif: X.fundae.empresa.nif,
          razonSocial: X.fundae.empresa.razonSocial,
          plantilla: X.fundae.empresa.plantilla,
          creditoTotalCents: X.fundae.empresa.creditoCents,
        },
        bearer: adminTok,
      });
      empresaId = empresa.id;
    }
    const grupos = await api<Array<{ id: string }>>('/api/v1/admin/fundae/groups', {
      bearer: adminTok,
    });
    if (grupos.length === 0) {
      await api('/api/v1/admin/fundae/groups', {
        method: 'POST',
        body: {
          actionId: accionFundaeId,
          companyId: empresaId,
          numeroGrupo: X.fundae.grupo.numero,
          modalidad: 'TELEFORMACION',
          fechaInicioPrevista: X.fundae.accion.inicio,
          fechaFinPrevista: X.fundae.accion.fin,
          creditoEstimadoCents: X.fundae.grupo.creditoCents,
        },
        bearer: adminTok,
      });
    }
  });

  await estado('gamificación: niveles, retos, entrega y puntos', async () => {
    const niveles = await api<{ levels: Array<{ key: string }> }>(
      '/api/v1/modules/gamification/levels',
      {
        bearer: adminTok,
      },
    );
    for (const nivel of X.niveles) {
      if (!niveles.levels.some((l) => l.key === nivel.key)) {
        await api('/api/v1/modules/gamification/admin/levels', {
          method: 'POST',
          body: {
            key: nivel.key,
            name: nivel.nombre,
            minPoints: nivel.minPoints,
            benefitText: nivel.beneficio,
          },
          bearer: adminTok,
        }).catch(() => undefined);
      }
    }
    const existentes = await api<{ challenges: Array<{ id: string; title: string }> }>(
      '/api/v1/modules/gamification/admin/challenges',
      { bearer: adminTok },
    );
    for (const reto of X.retos) {
      if (!existentes.challenges.some((c) => c.title === reto.titulo)) {
        await api('/api/v1/modules/gamification/admin/challenges', {
          method: 'POST',
          body: {
            title: reto.titulo,
            description: reto.descripcion,
            points: reto.puntos,
            proofRequired: reto.prueba,
            status: 'OPEN',
          },
          bearer: adminTok,
        });
      }
    }
    // La entrega de la alumna con prueba adjunta: es lo que la pestaña
    // «Entregas» del panel revisa.
    const visibles = await api<{
      challenges: Array<{ id: string; title: string; mySubmission?: unknown }>;
    }>('/api/v1/modules/gamification/challenges', { bearer: alumnaTok });
    const retoConPrueba = visibles.challenges.find((c) => c.title === X.retos[0].titulo);
    if (retoConPrueba && !retoConPrueba.mySubmission) {
      await api(`/api/v1/modules/gamification/challenges/${retoConPrueba.id}/submit`, {
        method: 'POST',
        body: {
          proofUrl: X.entrega.proofUrl,
          proofName: X.entrega.proofName,
          note: X.entrega.nota,
        },
        bearer: alumnaTok,
      });
    }
    // El backfill puntúa la actividad ya existente (posts, comentarios,
    // recursos, cursos): con él /challenges y /leaderboard tienen números reales.
    await api('/api/v1/modules/gamification/admin/backfill', {
      method: 'POST',
      body: {},
      bearer: adminTok,
    });
  });

  await estado('mensajería: canal de profesores y directo', async () => {
    const canal = await api<{ conversationId: string }>('/api/v1/modules/messaging/faculty/open', {
      method: 'POST',
      body: {},
      bearer: alumnaTok,
    });
    const mensajes = await api<{ messages: Array<{ body: string }> }>(
      `/api/v1/modules/messaging/conversations/${canal.conversationId}/messages`,
      { bearer: alumnaTok },
    );
    if (mensajes.messages.length === 0) {
      await api(`/api/v1/modules/messaging/conversations/${canal.conversationId}/messages`, {
        method: 'POST',
        body: { body: X.mensajes.alumna1 },
        bearer: alumnaTok,
      });
      await api(`/api/v1/modules/messaging/conversations/${canal.conversationId}/messages`, {
        method: 'POST',
        body: { body: X.mensajes.alumna2 },
        bearer: alumnaTok,
      });
      // La respuesta del staff: para el admin este mismo hilo es una
      // conversación de «Consultas de alumnos».
      await api(`/api/v1/modules/messaging/conversations/${canal.conversationId}/messages`, {
        method: 'POST',
        body: { body: X.mensajes.profe },
        bearer: adminTok,
      });
    }
    mensajeParaClicar = X.mensajes.profe;

    const dm = await api<{ conversationId: string }>('/api/v1/modules/messaging/dm', {
      method: 'POST',
      body: { userId: alumnaId },
      bearer: adminTok,
    });
    const dmMensajes = await api<{ messages: Array<{ body: string }> }>(
      `/api/v1/modules/messaging/conversations/${dm.conversationId}/messages`,
      { bearer: adminTok },
    );
    if (dmMensajes.messages.length === 0) {
      await api(`/api/v1/modules/messaging/conversations/${dm.conversationId}/messages`, {
        method: 'POST',
        body: { body: X.mensajes.dm },
        bearer: adminTok,
      });
    }
  });

  await estado('configuración WP-SSO', async () => {
    await api('/api/v1/admin/sso/wp/config', {
      method: 'PUT',
      body: {
        enabled: true,
        sharedSecret: X.wpSso.secreto,
        issuer: X.wpSso.homeUrl,
        autoCreate: true,
        autoRedirect: false,
      },
      bearer: adminTok,
    });
  });

  await estado('registro de miembros (Telegram + OTP)', async () => {
    await api('/api/v1/tenant-settings/member-registration/verification', {
      method: 'PUT',
      body: { value: { enabled: true, verifiers: ['telegram', 'otp'] }, isSecret: false },
      bearer: adminTok,
    });
    await api('/api/v1/tenant-settings/member-registration/telegram', {
      method: 'PUT',
      body: {
        value: {
          botToken: X.registro.botToken,
          groupId: X.registro.groupId,
          botUsername: X.registro.botUsername,
        },
        isSecret: true,
      },
      bearer: adminTok,
    });
    await api('/api/v1/tenant-settings/member-registration/approval', {
      method: 'PUT',
      body: { value: { email: DEMO.admin.email }, isSecret: false },
      bearer: adminTok,
    });
  });

  // ══════════════════════════════════════════════════ FASE DE CAPTURAS ══

  // ── hello-world ──────────────────────────────────────────────────────
  await captura('hello-world', 'hello-world-1-modulos', async () => {
    await admin.goto('/admin/settings?tab=modules');
    const fila = admin.getByText(/mod\.hello-world@/);
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await assertLocale(admin, LOCALE);
    await shot(admin, walk('hello-world'), 'hello-world-1-modulos', { scrollTo: fila });
  });

  // ── ai-content ───────────────────────────────────────────────────────
  await captura('ai-content', 'ai-content-1-modulo', async () => {
    await admin.goto('/admin/settings?tab=modules');
    const fila = admin.getByText(/mod\.ai-content@/);
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('ai-content'), 'ai-content-1-modulo', { scrollTo: fila });
  });

  await captura('ai-content', 'ai-content-2-proveedores', async () => {
    await admin.goto('/admin/ai/providers');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'aiProviders.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('ai-content'), 'ai-content-2-proveedores');
  });

  // ── courses ──────────────────────────────────────────────────────────
  await captura('courses', 'courses-1-mis-cursos', async () => {
    await admin.goto('/studio/courses');
    await expect(
      admin.getByRole('heading', { name: t('formadorCursos', 'myCoursesTitle') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.cursoEdicion.titulo)).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('courses'), 'courses-1-mis-cursos');
  });

  await captura('courses', 'courses-2-builder', async () => {
    if (!cursoMarketing) throw new Error('no hay curso en borrador');
    await admin.goto(`/studio/courses/${cursoMarketing.id}`);
    const publicar = admin.getByRole('button', { name: t('formadorCursos', 'publish') });
    await expect(publicar).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('courses'), 'courses-2-builder');
  });

  await captura('courses', 'courses-3-categorias', async () => {
    await admin.goto('/admin/courses/categories');
    await expect(
      admin.getByRole('heading', { name: t('adminMonetizacion', 'categories.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.categorias[1].name).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('courses'), 'courses-3-categorias');
  });

  await captura('courses', 'courses-4-catalogo', async () => {
    await alumna.goto('/courses');
    await expect(alumna.getByText(X.cursoEdicion.titulo)).toBeVisible({ timeout: 30_000 });
    await assertLocale(alumna, LOCALE);
    await shot(alumna, walk('courses'), 'courses-4-catalogo');
  });

  // ── learning ─────────────────────────────────────────────────────────
  await captura('learning', 'learning-1-drip', async () => {
    if (!cursoEdicion) throw new Error('no hay curso de edición');
    await admin.goto(`/studio/courses/${cursoEdicion.id}`);
    const drip = admin.getByText(t('formadorCursos', 'dripTitle')).first();
    await expect(drip).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('learning'), 'learning-1-drip', { scrollTo: drip });
  });

  await captura('learning', 'learning-2-invitaciones', async () => {
    if (!cursoDemo) throw new Error('no hay curso demo');
    await admin.goto(`/studio/courses/${cursoDemo.id}`);
    const generar = admin.getByRole('button', { name: t('formadorCursos', 'generate') });
    await expect(generar).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('learning'), 'learning-2-invitaciones', { scrollTo: generar });
  });

  await captura('learning', 'learning-3-alumnos', async () => {
    if (!cursoDemo) throw new Error('no hay curso demo');
    await admin.goto(`/studio/courses/${cursoDemo.id}/students`);
    await expect(
      admin.getByRole('heading', { name: t('formadorCursos', 'studentsTitle') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(DEMO.alumna.name).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('learning'), 'learning-3-alumnos');
  });

  await captura('learning', 'learning-4-ficha-alumno', async () => {
    await alumna.goto(`/courses/${X.cursoEdicion.slug}`);
    await expect(alumna.getByText(t('alumnoAprendizaje', 'yourProgress'))).toBeVisible({
      timeout: 30_000,
    });
    await shot(alumna, walk('learning'), 'learning-4-ficha-alumno');
  });

  // ── assessments (+ ai-grader comparte estado) ────────────────────────
  await captura('assessments', 'assessments-1-editor', async () => {
    if (!quizId) throw new Error('no hay quiz');
    await admin.goto(`/studio/quizzes/${quizId}`);
    await expect(admin.getByText(X.quiz.titulo).first()).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.quiz.single.prompt).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('assessments'), 'assessments-1-editor');
  });

  await captura('assessments', 'assessments-2-quiz-alumno', async () => {
    if (!quizId) throw new Error('no hay quiz');
    await alumna.goto(`/courses/${DEMO.course.slug}`);
    await expect(alumna.getByText(t('alumnoAprendizaje', 'yourProgress'))).toBeVisible({
      timeout: 30_000,
    });
    // La lección de tipo QUIZ del temario; el reproductor de quiz sale debajo.
    await alumna.getByRole('button', { name: reEscape(X.quiz.leccion) }).click();
    const empezar = alumna.getByRole('button', { name: t('playersContenido', 'quiz.start') });
    await expect(empezar).toBeVisible({ timeout: 30_000 });
    await empezar.click();
    await expect(alumna.getByText(X.quiz.single.prompt)).toBeVisible({ timeout: 30_000 });
    // Una opción marcada: el intento se ve vivo, no recién abierto.
    await alumna.getByText(X.quiz.single.opciones[0]).first().click();
    await shot(alumna, walk('assessments'), 'assessments-2-quiz-alumno');
  });

  await estado('intento enviado (queda pendiente de corrección)', async () => {
    if (!quizId) throw new Error('no hay quiz');
    // Si la captura anterior arrancó el intento por la interfaz se reutiliza;
    // si no, se arranca por API. En ambos casos se envía con la abierta
    // contestada → PENDING_REVIEW en la bandeja del formador.
    const intentos = await api<IntentoApi[]>(
      `/api/v1/modules/assessments/attempts?quizId=${quizId}`,
      {
        bearer: alumnaTok,
      },
    );
    let intento = intentos.find((a) => a.status === 'IN_PROGRESS');
    if (!intento) {
      intento = await api<IntentoApi>('/api/v1/modules/assessments/attempts', {
        method: 'POST',
        body: { quizId },
        bearer: alumnaTok,
      });
    }
    const vista = await api<{ questions: PreguntaAlumnoApi[] }>(
      `/api/v1/modules/assessments/quizzes/${quizId}/preview`,
      { bearer: alumnaTok },
    );
    const answers = vista.questions.map((q) => {
      if (q.type === 'FILL_IN_BLANK')
        return { questionId: q.id, textAnswer: X.quiz.hueco.respuesta };
      if (q.type === 'SHORT_ANSWER' || q.type === 'LONG_ANSWER') {
        return { questionId: q.id, textAnswer: X.quiz.abierta.respuesta };
      }
      const opcion = q.options[0];
      return { questionId: q.id, selectedOptionIds: opcion ? [opcion.id] : [] };
    });
    await api(`/api/v1/modules/assessments/attempts/${intento.id}/submit`, {
      method: 'POST',
      body: { answers },
      bearer: alumnaTok,
    });
  });

  await captura('assessments', 'assessments-3-correcciones', async () => {
    await admin.goto('/studio/grading');
    await expect(
      admin.getByRole('heading', { name: t('formadorAula', 'correcciones.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.quiz.titulo).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('assessments'), 'assessments-3-correcciones');
  });

  await captura('ai-grader', 'ai-grader-1-pendientes', async () => {
    await admin.goto('/studio/grading');
    await expect(admin.getByText(X.quiz.titulo).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('ai-grader'), 'ai-grader-1-pendientes');
  });

  await captura('assessments', 'assessments-4-correccion-detalle', async () => {
    const pendientes = await api<Array<{ id: string }>>(
      '/api/v1/modules/assessments/attempts/pending',
      {
        bearer: adminTok,
      },
    );
    const primero = pendientes[0];
    if (!primero) throw new Error('no hay intentos pendientes');
    await admin.goto(`/studio/grading/${primero.id}`);
    await expect(admin.getByText(X.quiz.abierta.respuesta.slice(0, 40)).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('assessments'), 'assessments-4-correccion-detalle');
  });

  await captura('ai-grader', 'ai-grader-2-detalle', async () => {
    const pendientes = await api<Array<{ id: string }>>(
      '/api/v1/modules/assessments/attempts/pending',
      {
        bearer: adminTok,
      },
    );
    const primero = pendientes[0];
    if (!primero) throw new Error('no hay intentos pendientes');
    await admin.goto(`/studio/grading/${primero.id}`);
    await expect(admin.getByText(X.quiz.abierta.respuesta.slice(0, 40)).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('ai-grader'), 'ai-grader-2-detalle');
  });

  await captura('ai-grader', 'ai-grader-3-proveedores', async () => {
    await admin.goto('/admin/ai/providers');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'aiProviders.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('ai-grader'), 'ai-grader-3-proveedores');
  });

  // ── ai-tutor ─────────────────────────────────────────────────────────
  await captura('ai-tutor', 'ai-tutor-1-proveedores', async () => {
    await admin.goto('/admin/ai/providers');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'aiProviders.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('ai-tutor'), 'ai-tutor-1-proveedores');
  });

  await captura('ai-tutor', 'ai-tutor-2-panel-alumno', async () => {
    await alumna.goto(`/courses/${DEMO.course.slug}`);
    const panel = alumna.getByText(t('playersContenido', 'aiTutor.title')).first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('ai-tutor'), 'ai-tutor-2-panel-alumno', { scrollTo: panel });
  });

  await captura('ai-tutor', 'ai-tutor-3-admin-revision', async () => {
    // Sin clave de IA nadie ha preguntado: la pestaña Revisión sale con su
    // estado vacío, que la propuesta da por válido como captura de respaldo.
    await admin.goto('/admin/ai/tutor');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'aiTutor.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('ai-tutor'), 'ai-tutor-3-admin-revision');
  });

  // ── access-groups ────────────────────────────────────────────────────
  await captura('access-groups', 'access-groups-1-lista', async () => {
    await admin.goto('/admin/access-groups');
    await expect(
      admin.getByRole('heading', { name: t('adminUsuarios', 'groups.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.getByText(X.grupoAvanzado).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('access-groups'), 'access-groups-1-lista');
  });

  await captura('access-groups', 'access-groups-2-gestion', async () => {
    await admin.goto('/admin/access-groups');
    await expect(admin.getByText(X.grupoAvanzado).first()).toBeVisible({ timeout: 30_000 });
    const gestionar = admin.getByRole('button', { name: t('adminUsuarios', 'groups.manage') });
    // La fila del grupo «Varios cursos»: el contenedor más profundo que tiene
    // a la vez el nombre y un botón Gestionar.
    const fila = admin
      .locator('div, li')
      .filter({ hasText: X.grupoAvanzado })
      .filter({ has: gestionar })
      .last();
    await fila.getByRole('button', { name: t('adminUsuarios', 'groups.manage') }).click();
    await expect(
      admin.getByText(t('adminUsuarios', 'groups.manageTitle', { name: X.grupoAvanzado })),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('access-groups'), 'access-groups-2-gestion');
  });

  await captura('access-groups', 'access-groups-3-membresia', async () => {
    await admin.goto('/admin/membership');
    const selector = admin.locator('#cfg-group');
    await expect(selector).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('access-groups'), 'access-groups-3-membresia', { scrollTo: selector });
  });

  // ── subscriptions ────────────────────────────────────────────────────
  await captura('subscriptions', 'subscriptions-1-membresia-planes', async () => {
    await admin.goto('/admin/membership');
    await expect(admin.locator('#plan-name')).toBeVisible({ timeout: 30_000 });
    const anual = admin.getByText(X.planAnual.nombre).first();
    await expect(anual).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('subscriptions'), 'subscriptions-1-membresia-planes', {
      scrollTo: anual,
    });
  });

  await captura('subscriptions', 'subscriptions-2-unete', async () => {
    await publicPage.goto('/join');
    await expect(publicPage.getByText(DEMO.unete.title)).toBeVisible({ timeout: 30_000 });
    await expect(publicPage.getByText(X.planAnual.nombre).first()).toBeVisible({ timeout: 30_000 });
    await assertLocale(publicPage, LOCALE);
    await shot(publicPage, walk('subscriptions'), 'subscriptions-2-unete');
  });

  // ── billing ──────────────────────────────────────────────────────────
  await captura('billing', 'billing-1-stripe-config', async () => {
    await admin.goto('/admin/settings?tab=pagos');
    // Con las claves falsas guardadas por el recorrido 2 el banner dice
    // «sin verificar»; si la tanda corre sin ese estado, cualquiera de los
    // banners de la tarjeta vale como pantalla real.
    await expect(admin.locator('[data-testid^="stripe-banner"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('billing'), 'billing-1-stripe-config');
  });

  await captura('billing', 'billing-2-productos', async () => {
    await admin.goto('/admin/billing/products');
    await expect(admin.locator('#courseId')).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('billing'), 'billing-2-productos');
  });

  // ── payment-connections ──────────────────────────────────────────────
  await captura('payment-connections', 'payment-connections-1-conectar', async () => {
    await admin.goto('/admin/integrations/payment-connections');
    await expect(
      admin.getByRole('heading', { name: t('adminPagos', 'connections.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('payment-connections'), 'payment-connections-1-conectar');
  });

  await captura('payment-connections', 'payment-connections-2-dashboard', async () => {
    await admin.goto('/admin/integrations/payment-connections');
    const panel = admin.getByText(t('adminPagos', 'dashboard.title')).first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('payment-connections'), 'payment-connections-2-dashboard', {
      scrollTo: panel,
    });
  });

  await captura('payment-connections', 'payment-connections-3-tiers', async () => {
    await admin.goto('/admin/integrations/payment-connections');
    const catalogo = admin.getByText(t('adminPagos', 'tiers.title')).first();
    await expect(catalogo).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText('Básico').first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('payment-connections'), 'payment-connections-3-tiers', {
      scrollTo: catalogo,
    });
  });

  // ── certificates ─────────────────────────────────────────────────────
  await captura('certificates', 'certificates-1-plantillas', async () => {
    await admin.goto('/studio/certificates/templates');
    await expect(
      admin.getByRole('heading', { name: t('formadorAula', 'certTemplates.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.plantillas.clasica.nombre).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('certificates'), 'certificates-1-plantillas');
  });

  await captura('certificates', 'certificates-2-editor', async () => {
    await admin.goto('/studio/certificates/templates');
    await admin
      .getByRole('button', { name: t('formadorAula', 'certTemplates.newTemplate') })
      .click();
    await admin.locator('#tpl-name').fill('Diploma de taller');
    await admin
      .locator('#tpl-body')
      .fill(
        '{{alumno}} ha participado en el taller {{curso}} celebrado el {{fecha}}. Nº {{numero}}.',
      );
    await admin.locator('#tpl-color').fill('#7C3AED');
    await admin.locator('#tpl-signer').fill(X.plantillas.firmada.firmante);
    await admin.locator('#tpl-signer-title').fill(X.plantillas.firmada.cargo);
    await shot(admin, walk('certificates'), 'certificates-2-editor');
    // Sin guardar: la plantilla de la captura no debe quedar en el listado.
    await admin.getByRole('button', { name: t('formadorAula', 'certTemplates.cancel') }).click();
  });

  await captura('certificates', 'certificates-3-mis-certificados', async () => {
    await alumna.goto('/my-certificates');
    await expect(alumna.getByText(/^[A-Z]{2}-\d{4}-\d{6}$/).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(alumna, walk('certificates'), 'certificates-3-mis-certificados');
  });

  await captura('certificates', 'certificates-4-verificar', async () => {
    if (!certificadoId) throw new Error('no hay certificado emitido');
    await publicPage.goto(`/verify/${certificadoId}`);
    await expect(publicPage.getByText(/[A-Z]{2}-\d{4}-\d{6}/).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(publicPage, walk('certificates'), 'certificates-4-verificar');
  });

  // ── community ────────────────────────────────────────────────────────
  await captura('community', 'community-1-feed', async () => {
    await alumna.goto('/community');
    await expect(
      alumna.getByRole('heading', { name: t('comunidadComponentes', 'feedTitle') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(alumna.getByText(X.posts.bienvenida.titulo).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(alumna, walk('community'), 'community-1-feed');
  });

  await captura('community', 'community-2-composer', async () => {
    await admin.goto('/community');
    await admin.getByRole('button', { name: t('comunidadComponentes', 'newConversation') }).click();
    await admin
      .getByPlaceholder(t('comunidadComponentes', 'titlePlaceholder'))
      .fill(X.composer.titulo);
    await admin
      .getByPlaceholder(t('comunidadComponentes', 'bodyPlaceholder'))
      .fill(X.composer.cuerpo);
    // El aviso por email es lo que distingue al composer del admin: marcado,
    // aparece el segundo checkbox «Importante (ignora las bajas)».
    await admin.getByText(t('comunidadComponentes', 'notifyAllLabel')).click();
    await expect(admin.getByText(t('comunidadComponentes', 'importantLabel'))).toBeVisible({
      timeout: 15_000,
    });
    await shot(admin, walk('community'), 'community-2-composer');
  });

  await captura('community', 'community-3-espacios', async () => {
    await admin.goto('/admin/community/spaces');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'spaces.title') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(X.espacio.titulo).first()).toBeVisible({ timeout: 30_000 });
    // Editar el espacio propio: los de sistema van con candado.
    const editar = admin.getByRole('button', { name: t('adminEngagement', 'spaces.edit') });
    const fila = admin
      .locator('li, div')
      .filter({ hasText: X.espacio.titulo })
      .filter({ has: editar })
      .last();
    await fila.getByRole('button', { name: t('adminEngagement', 'spaces.edit') }).click();
    await expect(
      admin.getByText(t('adminEngagement', 'spaces.formEditTitle', { name: X.espacio.titulo })),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('community'), 'community-3-espacios');
  });

  await captura('community', 'community-4-avisos', async () => {
    await admin.goto('/admin/broadcasts');
    await expect(admin.locator('#broadcast-subject')).toBeVisible({ timeout: 30_000 });
    // El historial de abajo enseña el envío DONE que preparó la fase de
    // estado; el compositor se retrata escrito pero sin enviar.
    await expect(admin.getByText(X.aviso.asunto).first()).toBeVisible({ timeout: 30_000 });
    await admin.locator('#broadcast-subject').fill('Recordatorio: entrega del reto semanal');
    await admin
      .locator('#broadcast-body')
      .fill('El domingo cierra el reto de la semana. Subid vuestra foto al espacio Proyectos.');
    await shot(admin, walk('community'), 'community-4-avisos');
  });

  // ── gamification ─────────────────────────────────────────────────────
  await captura('gamification', 'gamification-1-reglas', async () => {
    await admin.goto('/admin/gamification');
    await admin.getByRole('tab', { name: t('adminEngagement', 'gamification.tabRules') }).click();
    await expect(admin.getByText(t('adminEngagement', 'rules.backfillTitle'))).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('gamification'), 'gamification-1-reglas');
  });

  await captura('gamification', 'gamification-2-entregas', async () => {
    await admin.goto('/admin/gamification');
    await admin
      .getByRole('tab', { name: t('adminEngagement', 'gamification.tabSubmissions') })
      .click();
    await expect(admin.getByText(X.retos[0].titulo).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('gamification'), 'gamification-2-entregas');
  });

  await captura('gamification', 'gamification-3-retos', async () => {
    await alumna.goto('/challenges');
    await expect(alumna.getByText(X.retos[0].titulo).first()).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('gamification'), 'gamification-3-retos');
  });

  await captura('gamification', 'gamification-4-clasificacion', async () => {
    await alumna.goto('/leaderboard');
    await expect(
      alumna.getByRole('heading', { name: t('alumnoSocial', 'leaderboard.titulo') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('gamification'), 'gamification-4-clasificacion');
  });

  // ── messaging ────────────────────────────────────────────────────────
  await captura('messaging', 'messaging-1-bandeja', async () => {
    await alumna.goto('/messages');
    await expect(
      alumna.getByRole('heading', { name: t('alumnoSocial', 'mensajes.titulo') }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      alumna.getByText(t('alumnoSocial', 'mensajes.grupoProfesores')).first(),
    ).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('messaging'), 'messaging-1-bandeja');
  });

  await captura('messaging', 'messaging-3-profesores', async () => {
    if (!mensajeParaClicar) throw new Error('no hay conversación con el profesorado');
    await alumna.goto('/messages');
    // La lista enseña el último mensaje de cada conversación: clicar ese
    // texto abre el canal de profesores sin depender del título que ponga el
    // backend al hilo.
    await alumna.getByText(mensajeParaClicar.slice(0, 30)).first().click();
    await expect(alumna.getByText(t('alumnoSocial', 'mensajes.canalProfesores'))).toBeVisible({
      timeout: 30_000,
    });
    await expect(alumna.getByText(X.mensajes.alumna1).first()).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('messaging'), 'messaging-3-profesores');
  });

  await captura('messaging', 'messaging-2-directo', async () => {
    await alumna.goto('/messages');
    await alumna
      .getByRole('button', { name: t('alumnoSocial', 'mensajes.nuevaConversacion') })
      .click();
    const buscador = alumna.getByPlaceholder(
      t('alumnoSocial', 'mensajes.buscarMiembroPlaceholder'),
    );
    await expect(buscador).toBeVisible({ timeout: 15_000 });
    await buscador.fill('Demo');
    await expect(alumna.getByText(DEMO.admin.name).first()).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('messaging'), 'messaging-2-directo');
  });

  // ── zoom-live ────────────────────────────────────────────────────────
  await captura('zoom-live', 'zoom-live-1-credenciales', async () => {
    await admin.goto('/admin/settings?tab=aula-virtual');
    await expect(admin.locator('#zoom-account')).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('zoom-live'), 'zoom-live-1-credenciales');
  });

  await captura('zoom-live', 'zoom-live-2-aula-virtual', async () => {
    await admin.goto('/studio/live');
    await expect(admin.getByRole('heading', { name: t('formadorAula', 'aula.title') })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(admin.getByText(X.clase.tema).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('zoom-live'), 'zoom-live-2-aula-virtual');
  });

  await captura('zoom-live', 'zoom-live-3-clase-alumno', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión de aula virtual');
    // ⚠️ Orden importante: la alumna aún NO está inscrita — es lo que enseña
    // el botón «Inscribirme». Su inscripción llega justo después, por API.
    await alumna.goto(`/live/${sesionZoomId}`);
    const inscribirse = alumna.getByRole('button', { name: t('alumnoAprendizaje', 'register') });
    await expect(inscribirse).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('zoom-live'), 'zoom-live-3-clase-alumno');
  });

  await estado('alumna inscrita a la clase (con evidencia de entrada)', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión');
    await api(`/api/v1/modules/zoom-live/sessions/${sesionZoomId}/register`, {
      method: 'POST',
      body: {},
      bearer: alumnaTok,
    }).catch(() => undefined);
    // El «join» sella la entrada: en el panel de asistencia la fila pasa a
    // evidencia PROXY, que es lo que documenta la captura.
    await api(`/api/v1/modules/zoom-live/sessions/${sesionZoomId}/join`, {
      method: 'POST',
      body: {},
      bearer: alumnaTok,
    }).catch(() => undefined);
  });

  await captura('zoom-live', 'zoom-live-4-asistencia', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión de aula virtual');
    await admin.goto(`/live/${sesionZoomId}`);
    await expect(admin.getByText(X.clase.tema).first()).toBeVisible({ timeout: 30_000 });
    const filaAlumna = admin.getByText(DEMO.alumna.name).last();
    await expect(filaAlumna).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('zoom-live'), 'zoom-live-4-asistencia', { scrollTo: filaAlumna });
  });

  // ── surveys ──────────────────────────────────────────────────────────
  await estado('encuesta post-clase creada', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión');
    // El endpoint admin crea la encuesta sin esperar al webhook de fin de
    // reunión de Zoom (idempotente).
    await api(`/api/v1/modules/surveys/admin/sessions/${sesionZoomId}`, {
      method: 'POST',
      body: {},
      bearer: adminTok,
    });
  });

  await captura('surveys', 'surveys-3-alumno-panel', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión');
    // Antes de que la alumna responda: la tarjeta sale con los botones sin
    // seleccionar.
    await alumna.goto(`/live/${sesionZoomId}`);
    const panel = alumna.getByText(t('modSurveys', 'panelTitle')).first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('surveys'), 'surveys-3-alumno-panel', { scrollTo: panel });
  });

  await estado('respuestas de la encuesta', async () => {
    if (!sesionZoomId) throw new Error('no hay sesión');
    // Dos respuestas reales y variadas (promotora y detractor): las respuestas
    // son anónimas y cualquier miembro autenticado puede enviar la suya.
    const contestar = async (bearer: string, npsAlto: boolean) => {
      const encuesta = await api<{
        survey: {
          id: string;
          alreadyAnswered: boolean;
          questions: Array<{ id: string; type: string }>;
        } | null;
      }>(`/api/v1/modules/surveys/sessions/${sesionZoomId}`, { bearer });
      if (!encuesta.survey || encuesta.survey.alreadyAnswered) return;
      const answers = encuesta.survey.questions.map((q) => {
        if (q.type === 'NPS') return { questionId: q.id, valueInt: npsAlto ? 10 : 4 };
        if (q.type === 'SCALE') return { questionId: q.id, valueInt: npsAlto ? 5 : 3 };
        return {
          questionId: q.id,
          valueText: npsAlto
            ? 'La revisión de porfolios en directo me ayudó muchísimo.'
            : 'Me habría gustado más tiempo para preguntas.',
        };
      });
      await api(`/api/v1/modules/surveys/${encuesta.survey.id}/responses`, {
        method: 'POST',
        body: { answers },
        bearer,
      });
    };
    await contestar(alumnaTok, true);
    await contestar(adminTok, false);
  });

  await captura('surveys', 'surveys-1-admin-listado', async () => {
    await admin.goto('/admin/surveys');
    await expect(
      admin.getByRole('heading', { name: t('adminEngagement', 'surveys.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.getByText(X.clase.tema).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('surveys'), 'surveys-1-admin-listado');
  });

  await captura('surveys', 'surveys-2-admin-resultados', async () => {
    await admin.goto('/admin/surveys');
    await admin
      .getByRole('button', { name: t('adminEngagement', 'surveys.results') })
      .first()
      .click();
    await expect(admin.getByText(t('adminEngagement', 'surveys.npsLabel')).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('surveys'), 'surveys-2-admin-resultados');
  });

  // ── fundae ───────────────────────────────────────────────────────────
  await captura('fundae', 'fundae-1-acciones', async () => {
    await admin.goto('/admin/fundae');
    await expect(
      admin.getByRole('heading', { name: t('adminFundae', 'actions.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.getByText(X.fundae.accion.codigo).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('fundae'), 'fundae-1-acciones');
  });

  await captura('fundae', 'fundae-2-accion-bloques', async () => {
    if (!accionFundaeId) throw new Error('no hay acción formativa');
    await admin.goto(`/admin/fundae/${accionFundaeId}`);
    await expect(admin.getByRole('heading', { name: X.fundae.accion.nombre })).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.getByText(X.fundae.bloques[0].titulo).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('fundae'), 'fundae-2-accion-bloques');
  });

  await captura('fundae', 'fundae-4-grupo-detalle', async () => {
    await admin.goto('/admin/fundae/groups');
    await expect(
      admin.getByRole('heading', { name: t('adminFundae', 'groups.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await admin
      .getByRole('button', { name: t('adminFundae', 'groups.viewDetail') })
      .first()
      .click();
    await expect(admin.getByText(t('adminFundae', 'groups.costsTitle')).first()).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('fundae'), 'fundae-4-grupo-detalle');
  });

  // ── referrals ────────────────────────────────────────────────────────
  await captura('referrals', 'referrals-1-admin-config', async () => {
    await admin.goto('/admin/referrals');
    await expect(
      admin.getByRole('heading', { name: t('adminMonetizacion', 'referrals.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('referrals'), 'referrals-1-admin-config');
  });

  await captura('referrals', 'referrals-2-miembro', async () => {
    // La página crea el enlace de la alumna al entrar; con el programa activo
    // basta la visita.
    await alumna.goto('/referrals');
    await expect(
      alumna.getByRole('heading', { name: t('alumnoSocial', 'referidos.titulo') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await shot(alumna, walk('referrals'), 'referrals-2-miembro');
  });

  await captura('referrals', 'referrals-3-admin-comisiones', async () => {
    await admin.goto('/admin/referrals');
    await expect(
      admin.getByRole('heading', { name: t('adminMonetizacion', 'referrals.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    // Sin cobros de Stripe los rankings salen con su estado vacío real; el
    // encuadre baja hasta esas tarjetas.
    await admin.mouse.wheel(0, 1600);
    await shot(admin, walk('referrals'), 'referrals-3-admin-comisiones');
  });

  // ── resources ────────────────────────────────────────────────────────
  await captura('resources', 'resources-4-nueva-coleccion', async () => {
    await admin.goto('/resources');
    await admin.getByRole('button', { name: t('alumnoAprendizaje', 'newCollection') }).click();
    await admin.locator('#col-title').fill(X.coleccionNueva.titulo);
    await admin.locator('#col-desc').fill(X.coleccionNueva.descripcion);
    await admin
      .locator('#col-cover')
      .setInputFiles({ name: 'portada.png', mimeType: 'image/png', buffer: gradientPng(640, 360) });
    // La portada sube al storage: el botón de quitarla es la señal de que ya
    // está aplicada a la vista previa.
    await expect(
      admin.getByRole('button', { name: t('modResources', 'collection.coverRemove') }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('resources'), 'resources-4-nueva-coleccion');
    // Se guarda de verdad: la parrilla de la siguiente captura la enseña con
    // su portada.
    await admin.getByRole('button', { name: t('modResources', 'collection.create') }).click();
    await expect(admin.getByText(X.coleccionNueva.titulo).first()).toBeVisible({ timeout: 30_000 });
  });

  await captura('resources', 'resources-1-colecciones', async () => {
    await alumna.goto('/resources');
    await expect(
      alumna.getByRole('heading', { name: t('alumnoAprendizaje', 'resourcesTitle') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await shot(alumna, walk('resources'), 'resources-1-colecciones');
  });

  await captura('resources', 'resources-2-compartir', async () => {
    await alumna.goto('/resources');
    await alumna.getByRole('button', { name: t('alumnoAprendizaje', 'shareResource') }).click();
    await alumna.locator('#res-title').fill(X.recursoModal.titulo);
    await alumna.locator('#res-collection').selectOption({ index: 0 });
    // Botón exacto: el label del input de fichero también empieza por
    // «Archivo…» y el getByText a secas resolvía a dos elementos.
    await alumna
      .getByRole('button', { name: t('modResources', 'share.kindFile'), exact: true })
      .click();
    await alumna.locator('#res-file').setInputFiles({
      name: 'checklist-de-viaje.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% checklist de viaje (demo)\n'),
    });
    await alumna.locator('#res-desc').fill(X.recursoModal.descripcion);
    await shot(alumna, walk('resources'), 'resources-2-compartir');
  });

  await captura('resources', 'resources-3-coleccion', async () => {
    if (!coleccionRecursosId) throw new Error('no hay colección con recursos');
    await alumna.goto(`/resources/${coleccionRecursosId}`);
    await expect(alumna.getByPlaceholder(t('alumnoAprendizaje', 'searchInCollection'))).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(alumna.getByText(X.recursos[0].titulo).first()).toBeVisible({ timeout: 30_000 });
    await shot(alumna, walk('resources'), 'resources-3-coleccion');
  });

  // ── member-registration ──────────────────────────────────────────────
  await captura('member-registration', 'member-registration-1-config', async () => {
    await admin.goto('/admin/settings?tab=registro');
    await expect(admin.locator('#mr-approver')).toBeVisible({ timeout: 30_000 });
    await expect(admin.locator('#mr-bot-username')).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('member-registration'), 'member-registration-1-config');
  });

  await estado('registro solo con OTP (para el wizard 100% local)', async () => {
    // El Login Widget de Telegram se carga desde telegram.org y exige un bot
    // real: con OTP a solas el wizard entero funciona contra el Mailpit del
    // stack, sin salir de la máquina.
    await api('/api/v1/tenant-settings/member-registration/verification', {
      method: 'PUT',
      body: { value: { enabled: true, verifiers: ['otp'] }, isSecret: false },
      bearer: adminTok,
    });
  });

  await captura('member-registration', 'member-registration-2-wizard', async () => {
    await publicPage.goto('/member-registration');
    await expect(publicPage.locator('#ins-email')).toBeVisible({ timeout: 30_000 });
    await publicPage.locator('#ins-email').fill(X.aspirante.email);
    await shot(publicPage, walk('member-registration'), 'member-registration-2-wizard');
  });

  await estado('solicitud de inscripción PENDING (OTP por Mailpit)', async () => {
    const solicitudes = await api<{ requests: Array<{ email: string }> }>(
      '/api/v1/modules/member-registration/admin/requests',
      { bearer: adminTok },
    );
    if (solicitudes.requests.some((r) => r.email === X.aspirante.email)) return;
    // El flujo real de la aspirante, entero por API: pedir el código, leerlo
    // del buzón de Mailpit, verificarlo y registrar la solicitud.
    await mailpitClear();
    await api('/api/v1/modules/member-registration/otp/request', {
      method: 'POST',
      body: { email: X.aspirante.email },
    });
    const correo = await mailpitWaitFor(X.aspirante.email);
    const codigo = correo.match(/\b(\d{6})\b/)?.[1];
    if (!codigo) throw new Error('el correo del OTP no trae un código de 6 dígitos');
    const verificacion = await api<{ verificationToken: string }>(
      '/api/v1/modules/member-registration/otp/verify',
      { method: 'POST', body: { email: X.aspirante.email, code: codigo } },
    );
    await api('/api/v1/modules/member-registration/register', {
      method: 'POST',
      body: {
        name: X.aspirante.nombre,
        password: X.aspirante.password,
        verificationToken: verificacion.verificationToken,
      },
    });
  });

  await captura('member-registration', 'member-registration-3-solicitudes', async () => {
    await admin.goto('/admin/member-requests');
    await expect(
      admin.getByRole('heading', { name: t('adminUsuarios', 'requests.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.getByText(X.aspirante.email).first()).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('member-registration'), 'member-registration-3-solicitudes');
  });

  // ── wp-sso ───────────────────────────────────────────────────────────
  await captura('wp-sso', 'wp-sso-1-config', async () => {
    await admin.goto('/admin/sso?tab=wordpress');
    await expect(admin.locator('#wp-issuer')).toBeVisible({ timeout: 30_000 });
    await expect(admin.locator('#wp-issuer')).toHaveValue(X.wpSso.homeUrl, { timeout: 30_000 });
    await shot(admin, walk('wp-sso'), 'wp-sso-1-config');
  });

  // ── migrator-learndash ───────────────────────────────────────────────
  await captura('migrator-learndash', 'migrator-learndash-1-marketplace', async () => {
    await admin.goto('/admin/marketplace');
    await expect(
      admin.getByRole('heading', { name: t('adminMonetizacion', 'marketplace.title') }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await shot(admin, walk('migrator-learndash'), 'migrator-learndash-1-marketplace');
  });

  // ── theming (al FINAL: cambia marca y toca el asistente de bienvenida) ──
  await estado('marca personalizada para las capturas de theming', async () => {
    // Hue distinto del que dejó el recorrido 1 (212): la escala y la vista
    // previa no salen en el azul por defecto. Se revierte al terminar.
    await api('/api/v1/modules/theming/me', {
      method: 'PUT',
      body: {
        brandHue: X.tema.hue,
        signinHeadline: X.tema.headline,
        signinSubheadline: X.tema.subheadline,
      },
      bearer: adminTok,
    });
  });

  await captura('theming', 'theming-1-branding-color', async () => {
    await admin.goto('/admin/branding');
    await expect(admin.locator('#brandHue')).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('theming'), 'theming-1-branding-color');
  });

  await captura('theming', 'theming-2-logo-modo', async () => {
    await admin.goto('/admin/branding');
    const bloque = admin.getByText(t('adminMarca', 'branding.logoModeLabel')).first();
    await expect(bloque).toBeVisible({ timeout: 30_000 });
    await shot(admin, walk('theming'), 'theming-2-logo-modo', { scrollTo: bloque });
  });

  await captura('theming', 'theming-4-signin', async () => {
    await publicPage.goto('/signin');
    await expect(publicPage.locator('#email')).toBeVisible({ timeout: 30_000 });
    await expect(publicPage.getByText(X.tema.headline)).toBeVisible({ timeout: 30_000 });
    await shot(publicPage, walk('theming'), 'theming-4-signin');
  });

  await captura('theming', 'theming-3-bienvenida-marca', async () => {
    // El asistente de la academia se «desanda» hasta el paso de marca. Va el
    // ÚLTIMO de la tanda: mientras la fila esté incompleta, el gate del shell
    // mandaría cualquier otra pantalla del admin a /welcome.
    await api('/api/v1/tenant-settings/onboarding/academy', {
      method: 'PUT',
      body: {
        value: { step: 'marca', done: ['nombre'], skipped: [], completedAt: null },
        isSecret: false,
      },
      bearer: adminTok,
    });
    try {
      await admin.goto('/welcome');
      await expect(
        admin.getByRole('heading', { name: t('bienvenida', 'marcaTitulo') }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await shot(admin, walk('theming'), 'theming-3-bienvenida-marca');
    } finally {
      // Pase lo que pase, el asistente vuelve a quedar completado: si no, la
      // siguiente sesión del admin rebotaría a /welcome.
      await completeAcademyOnboarding(adminTok).catch((e: unknown) => {
        console.warn(
          `[modulos] ⚠️ no se pudo restaurar el onboarding de academia: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  });

  await estado('marca restaurada (hue 212, sin titular)', async () => {
    await api('/api/v1/modules/theming/me', {
      method: 'PUT',
      body: { brandHue: 212, signinHeadline: null, signinSubheadline: null },
      bearer: adminTok,
    });
  });

  // ─────────────────────────────────────────────────────────── resumen ──
  console.warn(
    `[modulos] ${tomadas} capturas tomadas, ${saltadas.length} saltadas` +
      (saltadas.length ? `: ${saltadas.join(', ')}` : ''),
  );

  await adminCtx.close();
  await alumnaCtx.close();
  await publicCtx.close();
});

/**
 * Capturas de los `*.shots.json` que quedan FUERA a propósito (exigen estado
 * que este arnés no puede construir en local):
 *
 *  - `ai-tutor-4-admin-conocimiento` — crear conocimiento validado embebe la
 *    pregunta: necesita un proveedor de embeddings con clave REAL.
 *  - `billing-3-panel-compra` y `billing-4-ficha-publica` — un producto activo
 *    vinculado exige una cuenta Stripe de verdad (modo test); las claves del
 *    arnés son inventadas a propósito.
 *  - `subscriptions-3-cuenta-suscripcion` — una suscripción real requiere
 *    completar un checkout de Stripe.
 *  - `fundae-3-empresa-rlpt` — pide subir una notificación RLPT (PDF) al
 *    expediente de la empresa; ese flujo no está en los clients del web.
 *  - `member-registration-4-impagos` — anotado como fuera de alcance de esta
 *    tanda; el client `lib/payment-flags.ts` existe, así que es candidata
 *    fácil si se quiere añadir después.
 *  - `messaging-4-consultas` — la bandeja del staff con VARIAS consultas exige
 *    más de un alumno escribiendo por su canal; la instancia demo tiene una.
 *  - `migrator-learndash-2-wizard-conectar` y `migrator-learndash-3-monitor` —
 *    la superficie admin del migrador se carga desde el ZIP instalado por el
 *    marketplace; en el stack del arnés el módulo no está instalado y la
 *    página muestra el error de carga, no el wizard.
 */
