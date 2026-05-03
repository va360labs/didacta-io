/**
 * Copy didáctico del wizard, en español, para usuarios no técnicos.
 * Cada string puede pasar por i18n del host vía `useTranslations()` —
 * estos son los defaults.
 */

export const WIZARD_COPY = {
  steps: {
    welcome: {
      title: 'Migrar desde WordPress + LearnDash',
      heading: '¿Listo para traer tu academia a Didacta?',
      lead:
        'Te vamos a guiar paso a paso para mover tus cursos, lecciones, alumnos y matrículas desde tu LearnDash actual hasta Didacta. No hace falta saber programar.',
      checklist: [
        'Acceso de administrador a tu WordPress con LearnDash.',
        'Un Application Password de WordPress (te enseñamos a crearlo).',
        'Unos minutos. Si tu academia es grande, te avisamos antes de empezar.',
      ],
      cta: 'Comenzar',
    },
    connect: {
      title: 'Conectar con tu WordPress',
      heading: 'Cuéntanos dónde está tu LearnDash',
      lead:
        'Necesitamos la URL de tu sitio y un Application Password (no tu contraseña normal). Es más seguro porque puedes revocarlo cuando quieras.',
      fields: {
        sourceUrl: {
          label: 'URL de tu WordPress',
          placeholder: 'https://miacademia.com',
          help: 'Debe empezar por https:// y ser pública.',
        },
        username: {
          label: 'Usuario administrador',
          placeholder: 'admin',
          help: 'El usuario WP con permisos para leer cursos, lecciones y alumnos.',
        },
        appPassword: {
          label: 'Application Password',
          placeholder: 'abcd EFGH ijkl MNOP',
          help: 'Lo creas en WordPress → Usuarios → Tu perfil → Application Passwords.',
        },
      },
      tipsLink: { label: 'Cómo crear un Application Password', href: '/help/learndash-app-password' },
      verifying: 'Verificando conexión...',
      cta: 'Comprobar y continuar',
    },
    preflight: {
      title: 'Esto es lo que vamos a migrar',
      lead: 'Hemos echado un vistazo a tu academia. Esto es lo que encontramos:',
      summary: 'Resumen del origen',
      warningsTitle: 'Avisos',
      cta: 'Continuar',
    },
    options: {
      title: '¿Cómo quieres hacer la migración?',
      lead: 'Los valores por defecto son los más seguros. Cámbialos solo si sabes lo que haces.',
      sections: {
        users: {
          title: 'Usuarios y contraseñas',
          dedupe: {
            label: 'Detectar duplicados por:',
            options: { email: 'Email', username: 'Nombre de usuario' },
          },
          password: {
            label: '¿Qué hacemos con las contraseñas?',
            options: {
              activation_reset: 'Enviar email de bienvenida con activación (recomendado)',
              preserve_hash: 'Intentar conservar la contraseña original (avanzado)',
            },
          },
        },
        media: {
          title: 'Imágenes y archivos',
          copyBinaries: { label: 'Copiar las imágenes a nuestro almacenamiento (recomendado)' },
        },
        scope: {
          title: '¿Qué quieres migrar?',
          courses: 'Cursos, lecciones y temas',
          quizzes: 'Quizzes y preguntas',
          users: 'Alumnos',
          groups: 'Grupos',
          enrollments: 'Matrículas',
          progress: 'Progreso de los alumnos',
          media: 'Imágenes y archivos',
        },
        groups: {
          title: 'Grupos de LearnDash',
          modelHint: {
            label: '¿Cómo modelamos los grupos en Didacta?',
            options: { cohort: 'Como cohortes (alumnos de una promoción)', organization: 'Como empresas/unidades' },
          },
        },
      },
      cta: 'Continuar',
    },
    dryrun: {
      title: 'Comprobación previa (sin tocar nada)',
      lead:
        'Vamos a hacer una prueba SIN escribir nada en Didacta. Verás un resumen de lo que pasaría si ejecutaras la migración.',
      runningTitle: 'Comprobando...',
      runningLead: 'Esto puede tardar entre 1 y 5 minutos según el tamaño de tu academia.',
      cta: 'Empezar la prueba',
      ctaContinue: 'Sí, todo correcto: ejecutar la migración real',
      ctaBack: 'Algo no me cuadra: ajustar opciones',
    },
    execute: {
      title: 'Migrando...',
      lead: 'Estamos importando tu academia. Puedes cerrar esta pestaña — el trabajo sigue en segundo plano.',
      cancelCta: 'Cancelar migración',
      cancelConfirm: '¿Seguro que quieres cancelar? Lo importado hasta ahora se queda; los datos restantes no se cargarán.',
      detailsToggle: 'Ver detalles técnicos',
    },
    done: {
      title: '¡Migración completada!',
      lead: 'Tu academia ya está en Didacta. Aquí tienes el resumen:',
      reportCta: 'Descargar reporte (CSV)',
      reportPdfCta: 'Descargar reporte para auditor (PDF)',
      goToCourses: 'Ver mis cursos en Didacta',
    },
  },

  errors: {
    AUTH_FAILED: {
      title: 'Las credenciales no son correctas',
      body: 'Asegúrate de usar un Application Password de WordPress, no tu contraseña normal. El Application Password se ve como cuatro grupos de cuatro letras.',
      ctaLabel: 'Cómo crear un Application Password',
      ctaHref: '/help/learndash-app-password',
    },
    SOURCE_UNREACHABLE: {
      title: 'No podemos conectar con tu WordPress',
      body: 'Comprueba que la URL es correcta y que el sitio es accesible públicamente desde Internet.',
    },
    CAPABILITY_MISSING: {
      title: 'Tu plan no incluye este migrador',
      body: 'La migración desde LearnDash requiere el plan Enterprise.',
      ctaLabel: 'Ver planes',
      ctaHref: '/admin/billing',
    },
    JOB_ALREADY_RUNNING: {
      title: 'Ya hay una migración en curso',
      body: 'Espera a que termine o cancélala antes de iniciar otra.',
    },
    JOB_NOT_FOUND: {
      title: 'No encontramos esa migración',
      body: 'Puede que se haya borrado o que el enlace esté caducado.',
    },
    DEPENDENCY_MODULE_MISSING: {
      title: 'Falta un módulo de Didacta',
      body: 'El migrador necesita los módulos Cursos, Aprendizaje y Evaluaciones para funcionar. Avísanos a soporte.',
    },
    GENERIC: {
      title: 'Algo no salió bien',
      body: 'Nuestro equipo ha sido notificado. Puedes ver los detalles técnicos para reportarlo a soporte.',
    },
  },
} as const;

export function copyForError(code: string | undefined): typeof WIZARD_COPY.errors[keyof typeof WIZARD_COPY.errors] {
  if (!code) return WIZARD_COPY.errors.GENERIC;
  return (WIZARD_COPY.errors as Record<string, typeof WIZARD_COPY.errors.GENERIC>)[code] ?? WIZARD_COPY.errors.GENERIC;
}
