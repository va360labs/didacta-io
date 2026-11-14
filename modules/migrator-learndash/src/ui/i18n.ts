/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Textos del bundle UI del migrador en español, inglés y portugués de Brasil.
 *
 * Viven AQUÍ, dentro del módulo, y no en los catálogos de `apps/web`: el bundle
 * llega en el ZIP firmado y el host no sabe nada de él (ADR-015). Del host solo
 * se toma el IDIOMA (`hooks.useLocale` / `i18n.getLocale` del runtime 1.1.0).
 *
 * Fichero PURO: no importa `./_runtime` (que exige `window.__didacta__` al
 * cargarse) para que los tests lo puedan cargar en Node. El idioma lo fija
 * `AdminSurface` en cada render con `setActiveLocale(useLocale())`; antes de
 * eso (o fuera de un render), `t()` se lo pregunta al runtime del host y, con
 * un host viejo sin `i18n`, a `<html lang>`, que fija el layout raíz.
 *
 * Reglas (las vigila `tests/unit/ui-i18n.test.ts`):
 *   - Las tres tablas tienen EXACTAMENTE las mismas claves, los mismos
 *     `{marcadores}` y las mismas etiquetas (`<b>`, `<strong>`, `<code>`).
 *   - `es` es el texto que el wizard tenía escrito a mano, sin cambiar una coma.
 *   - `pt` es portugués de Brasil: «você», lección → «aula», borrador →
 *     «rascunho», contraseña → «senha», email → «e-mail».
 *   - Cualquier idioma sin tabla (`fr-FR`) se pinta en español.
 *   - Fechas y números NO se escriben en las tablas: los formatea `Intl` con el
 *     locale activo (`formatNumber`, `formatDateTime`, `formatDay`, y los
 *     marcadores numéricos de `t()`).
 */

export type Lang = 'es' | 'en' | 'pt';

export const LANGS: readonly Lang[] = ['es', 'en', 'pt'];

const es = {
  'common.back': 'Volver',
  'common.continue': 'Continuar',
  'common.error': 'Error',
  'common.entity': 'Entidad',

  'admin.tabs.wizard': 'Crear migración',
  'admin.tabs.monitor': 'Monitor de migraciones',

  'entity.courses': 'Cursos',
  'entity.lessons': 'Lecciones',
  'entity.topics': 'Temas',
  'entity.quizzes': 'Quizzes',
  'entity.groups': 'Grupos',
  'entity.users': 'Alumnos',

  'wizard.error.jobCancelled': 'Job cancelado',
  'wizard.error.jobFailed': 'Job falló',
  'wizard.error.preflightFailed': 'Preflight falló',
  'wizard.error.connection': 'Error de conexión',
  'wizard.error.createJob': 'No se pudo crear el job',

  'wizard.scope.courses.label': 'Solo cursos',
  'wizard.scope.courses.help':
    'Importa el contenido: cursos, lecciones, temas y quizzes. No crea usuarios ni matrículas.',
  'wizard.scope.enrolledStudents.label': 'Solo alumnos matriculados en cursos',
  'wizard.scope.enrolledStudents.help':
    'Importa los alumnos con al menos una matrícula y sus inscripciones. Requiere que los cursos ya estén migrados (modo diferido).',
  'wizard.scope.all.label': 'Todo',
  'wizard.scope.all.help': 'Importa contenido + usuarios + matrículas. Es la opción completa.',

  'wizard.stepper.welcome': 'Inicio',
  'wizard.stepper.connect': 'Conectar',
  'wizard.stepper.preflight': 'Resumen',
  'wizard.stepper.options': 'Opciones',
  'wizard.stepper.sample': 'Prueba',
  'wizard.stepper.complete': 'Completa',

  'wizard.welcome.title': '¿Listo para traer tu academia a Didacta?',
  'wizard.welcome.description':
    'Te guiamos paso a paso. Necesitas un Application Password de tu WordPress (te enseñamos cómo crearlo) y unos minutos. Tu sitio actual no se modifica.',
  'wizard.welcome.reqAdmin': 'Acceso de administrador a tu WordPress con LearnDash.',
  'wizard.welcome.reqAppPassword': 'Application Password (no la contraseña normal).',
  'wizard.welcome.reqPublic': 'Sitio accesible públicamente (HTTPS).',
  'wizard.welcome.start': 'Comenzar',

  'wizard.connect.title': 'Conectar con tu WordPress',
  'wizard.connect.description': 'URL del sitio + Application Password.',
  'wizard.connect.urlLabel': 'URL de tu WordPress',
  'wizard.connect.urlPlaceholder': 'https://miacademia.com',
  'wizard.connect.userLabel': 'Usuario administrador',
  'wizard.connect.appPasswordLabel': 'Application Password',
  'wizard.connect.checking': 'Comprobando...',
  'wizard.connect.submit': 'Comprobar y continuar',

  'wizard.preflight.title': 'Esto es lo que vamos a migrar',
  'wizard.preflight.sourceFallback': 'Origen',
  'wizard.preflight.latency': 'latencia {ms} ms',
  'wizard.preflight.samplesTitle': 'Muestras de las últimas 5 entidades por tipo',
  'wizard.preflight.samplesNote':
    'Mostramos las 5 más recientes por tipo (incluye drafts, privadas y futuras programadas). Para revisar todo en detalle, abre tu WordPress origen — la migración traerá lo que coincida con las opciones que elijas en el siguiente paso.',
  'wizard.preflight.warningsTitle': 'Avisos del origen',
  'wizard.preflight.untitled': '(sin título · id={id})',

  'wizard.options.title': '¿Cómo quieres hacer la migración?',
  'wizard.options.description': 'Los valores por defecto son los más seguros.',
  'wizard.options.whatLabel': '¿Qué quieres migrar?',
  'wizard.options.coursesFirstTitle': 'Migra los cursos primero',
  'wizard.options.coursesFirstBody':
    'Este modo solo trae alumnos y matrículas. Las inscripciones se vinculan a los cursos que ya existan en Didacta: si un curso aún no se ha migrado, esa matrícula quedará registrada como incidencia en el informe. Lanza antes una migración de “{coursesOnly}” (o “{everything}”).',
  'wizard.options.passwordsLabel': 'Contraseñas',
  'wizard.options.passwordActivation': 'Enviar email de activación (recomendado)',
  'wizard.options.passwordPreserve': 'Conservar contraseña original (avanzado)',
  'wizard.options.imagesLabel': 'Imágenes',
  'wizard.options.copyImages': 'Copiar imágenes a Didacta (recomendado)',
  'wizard.options.howTitle': 'Cómo va a funcionar',
  'wizard.options.howBody':
    'Primero hacemos una <b>prueba</b>: importamos un curso de tu academia con hasta {users} alumnos para que verifiques que todo se ve bien en Didacta. Si te convence, te preguntamos si seguir con la <b>integración completa</b>; el curso de la prueba no se vuelve a importar (se reutiliza lo ya cargado), solo añadimos lo que falta.',
  'wizard.options.starting': 'Iniciando...',
  'wizard.options.startSample': 'Empezar la prueba',

  'wizard.sampleRun.title': 'Importando muestra…',
  'wizard.sampleRun.description':
    'Estamos trayendo {courses} curso aleatorio y hasta {users} alumnos para que verifiques el resultado.',

  'wizard.sampleDone.title': 'Prueba completada',
  'wizard.sampleDone.description': 'Estos son los resultados de la muestra:',
  'wizard.sampleDone.byEntityTitle': 'Detalle por entidad',
  'wizard.sampleDone.proceedTitle': '¿Quieres proceder con la integración completa?',
  'wizard.sampleDone.proceedBody':
    'Importaremos el resto de cursos, alumnos y contenidos. El curso y alumnos de la muestra <b>no se duplican</b>: se conservan tal como están y solo se añade lo que falta. Esta operación puede tardar varios minutos según el tamaño de tu academia.',
  'wizard.sampleDone.stopHere': 'Terminar aquí (conservo solo la muestra)',
  'wizard.sampleDone.starting': 'Iniciando…',
  'wizard.sampleDone.proceed': 'Sí, hacer integración completa',

  'wizard.stats.source': 'Origen',
  'wizard.stats.loaded': 'Cargados',
  'wizard.stats.skipped': 'Saltados',
  'wizard.stats.failed': 'Fallidos',

  'wizard.completeRun.title': 'Importando integración completa…',
  'wizard.completeRun.description':
    'Estamos trayendo el resto de tu academia. Puede tardar varios minutos.',

  'wizard.done.title': 'Migración finalizada',
  'wizard.done.fullReport': 'Reporte completo (job {jobId})',
  'wizard.done.sampleOnly':
    'Solo se importó la muestra (job {jobId}). Puedes lanzar la integración completa más tarde desde el dashboard del módulo.',
  'wizard.done.noReport': 'Sin reporte disponible.',
  'wizard.done.auditVerified': 'Cadena de auditoría: {count} eventos (✓ verificada).',
  'wizard.done.auditAltered': 'Cadena de auditoría: {count} eventos (⚠ alterada).',

  'wizard.running.statusTitle': 'Estado actual',
  'wizard.running.status': 'Job <code>{jobId}</code> · {status}',
  'wizard.running.statusWithPhase':
    'Job <code>{jobId}</code> · {status} · fase <code>{phase}</code>',
  'wizard.running.autoRefresh':
    'Esta pantalla se actualiza automáticamente cada {seconds} segundos. Puedes cerrar el navegador: el job continúa en segundo plano y al volver verás el reporte en el dashboard del módulo.',

  'wizard.notice.warning': 'Importante',
  'wizard.notice.error': 'Error',
  'wizard.notice.info': 'Info',

  'monitor.status.pending': 'Pendiente',
  'monitor.status.preflight': 'Preflight',
  'monitor.status.extracting': 'Extrayendo',
  'monitor.status.transforming': 'Transformando',
  'monitor.status.loading': 'Cargando',
  'monitor.status.reconciling': 'Reconciliando',
  'monitor.status.completed': 'Completado',
  'monitor.status.failed': 'Fallido',
  'monitor.status.cancelled': 'Cancelado',

  'monitor.cursor.extract': 'Extract: {current} página {page}',
  'monitor.cursor.extractWithTotals': 'Extract: {current} página {page} (totales: {totals})',
  'monitor.cursor.transform': 'Transform: {current} ({done} entidades completadas)',
  'monitor.cursor.load': 'Load: {current} ({done} entidades completadas)',

  'monitor.error.loadJobs': 'Error cargando jobs',
  'monitor.error.cancelJob': 'Error cancelando job',
  'monitor.loading': 'Cargando jobs…',
  'monitor.loadErrorLine': 'Error cargando jobs: {error}',
  'monitor.retry': 'Reintentar',
  'monitor.empty': 'Aún no hay migraciones para este tenant.',
  'monitor.emptyHint': 'Crea una desde la pestaña <strong>{tab}</strong>.',
  'monitor.activeSummary': '{count} migración(es) en curso · auto-refresh cada {seconds}s',
  'monitor.noActive': 'Sin migraciones activas en este momento',
  'monitor.refresh': '↻ Refrescar',
  'monitor.activeTitle': 'En curso',
  'monitor.historyTitle': 'Historial',
  'monitor.copyId': 'Copiar ID completo',
  'monitor.running': 'en ejecución',
  'monitor.finished': '· terminó {date}',
  'monitor.hide': 'Ocultar',
  'monitor.showDetail': 'Detalle',
  'monitor.cancel': 'Cancelar',
  'monitor.cancelDialog.title': '¿Cancelar esta migración?',
  'monitor.cancelDialog.body':
    'El job dejará de progresar después del tick actual. Lo que ya se cargó al core se mantiene (idempotencia por externalRef permite re-correr una migración nueva sin duplicar). Los rows en staging quedan para auditoría según retentionDays.',
  'monitor.cancelDialog.confirm': 'Sí, cancelar',

  'monitor.detail.loading': 'Cargando detalle…',
  'monitor.detail.reconciliationTitle': 'Reconciliación por entidad',
  'monitor.detail.colStaged': 'Staged',
  'monitor.detail.colValid': 'Válidas',
  'monitor.detail.colLoaded': 'Cargadas',
  'monitor.detail.colSkipped': 'Skipped',
  'monitor.detail.colFailed': 'Failed',
  'monitor.detail.total': 'Total',
  'monitor.detail.auditVerified':
    'Cadena de auditoría: {count} evento(s) · ✓ integridad verificada',
  'monitor.detail.auditUnverifiable':
    'Cadena de auditoría: {count} evento(s) · ✗ integridad no verificable',
  'monitor.detail.noReconciliation':
    'Aún no hay datos de reconciliación. El reporte se genera en la fase final del job.',

  'monitor.dlq.title': 'Dead Letter Queue',
  'monitor.dlq.count': '({total} fila(s), mostrando {shown})',
  'monitor.dlq.empty': 'Sin errores registrados — todas las filas procesadas OK.',
  'monitor.dlq.colSourceId': 'Source ID',
  'monitor.dlq.colPhase': 'Phase',
  'monitor.dlq.colError': 'Error',
  'monitor.dlq.colMessage': 'Mensaje',
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof es;

const en: Record<MessageKey, string> = {
  'common.back': 'Back',
  'common.continue': 'Continue',
  'common.error': 'Error',
  'common.entity': 'Entity',

  'admin.tabs.wizard': 'Create migration',
  'admin.tabs.monitor': 'Migration monitor',

  'entity.courses': 'Courses',
  'entity.lessons': 'Lessons',
  'entity.topics': 'Topics',
  'entity.quizzes': 'Quizzes',
  'entity.groups': 'Groups',
  'entity.users': 'Students',

  'wizard.error.jobCancelled': 'Job cancelled',
  'wizard.error.jobFailed': 'Job failed',
  'wizard.error.preflightFailed': 'Preflight failed',
  'wizard.error.connection': 'Connection error',
  'wizard.error.createJob': "Couldn't create the job",

  'wizard.scope.courses.label': 'Courses only',
  'wizard.scope.courses.help':
    "Imports the content: courses, lessons, topics and quizzes. Doesn't create users or enrollments.",
  'wizard.scope.enrolledStudents.label': 'Only students enrolled in courses',
  'wizard.scope.enrolledStudents.help':
    'Imports students with at least one enrollment, along with their enrollments. Requires the courses to be migrated already (deferred mode).',
  'wizard.scope.all.label': 'Everything',
  'wizard.scope.all.help': 'Imports content + users + enrollments. This is the full option.',

  'wizard.stepper.welcome': 'Start',
  'wizard.stepper.connect': 'Connect',
  'wizard.stepper.preflight': 'Summary',
  'wizard.stepper.options': 'Options',
  'wizard.stepper.sample': 'Test',
  'wizard.stepper.complete': 'Full',

  'wizard.welcome.title': 'Ready to bring your academy to Didacta?',
  'wizard.welcome.description':
    "We'll guide you step by step. You need an Application Password from your WordPress (we show you how to create one) and a few minutes. Your current site isn't changed.",
  'wizard.welcome.reqAdmin': 'Administrator access to your WordPress with LearnDash.',
  'wizard.welcome.reqAppPassword': 'Application Password (not your regular password).',
  'wizard.welcome.reqPublic': 'Publicly accessible site (HTTPS).',
  'wizard.welcome.start': 'Get started',

  'wizard.connect.title': 'Connect to your WordPress',
  'wizard.connect.description': 'Site URL + Application Password.',
  'wizard.connect.urlLabel': 'Your WordPress URL',
  'wizard.connect.urlPlaceholder': 'https://myacademy.com',
  'wizard.connect.userLabel': 'Administrator username',
  'wizard.connect.appPasswordLabel': 'Application Password',
  'wizard.connect.checking': 'Checking...',
  'wizard.connect.submit': 'Check and continue',

  'wizard.preflight.title': "Here's what we'll migrate",
  'wizard.preflight.sourceFallback': 'Source',
  'wizard.preflight.latency': 'latency {ms} ms',
  'wizard.preflight.samplesTitle': 'Samples of the latest 5 items per type',
  'wizard.preflight.samplesNote':
    'We show the 5 most recent per type (including drafts, private and scheduled ones). To review everything in detail, open your source WordPress — the migration will bring over whatever matches the options you choose in the next step.',
  'wizard.preflight.warningsTitle': 'Warnings from the source',
  'wizard.preflight.untitled': '(untitled · id={id})',

  'wizard.options.title': 'How do you want to run the migration?',
  'wizard.options.description': 'The default values are the safest.',
  'wizard.options.whatLabel': 'What do you want to migrate?',
  'wizard.options.coursesFirstTitle': 'Migrate the courses first',
  'wizard.options.coursesFirstBody':
    "This mode only brings over students and enrollments. Enrollments are linked to the courses that already exist in Didacta: if a course hasn't been migrated yet, that enrollment will be logged as an issue in the report. Run a “{coursesOnly}” (or “{everything}”) migration first.",
  'wizard.options.passwordsLabel': 'Passwords',
  'wizard.options.passwordActivation': 'Send activation email (recommended)',
  'wizard.options.passwordPreserve': 'Keep the original password (advanced)',
  'wizard.options.imagesLabel': 'Images',
  'wizard.options.copyImages': 'Copy images to Didacta (recommended)',
  'wizard.options.howTitle': 'How it will work',
  'wizard.options.howBody':
    "First we run a <b>test</b>: we import one course from your academy with up to {users} students so you can check that everything looks right in Didacta. If you're happy with it, we'll ask whether to go ahead with the <b>full integration</b>; the test course isn't imported again (what's already loaded is reused), we only add what's missing.",
  'wizard.options.starting': 'Starting...',
  'wizard.options.startSample': 'Start the test',

  'wizard.sampleRun.title': 'Importing sample…',
  'wizard.sampleRun.description':
    "We're bringing over {courses} random course and up to {users} students so you can check the result.",

  'wizard.sampleDone.title': 'Test completed',
  'wizard.sampleDone.description': 'These are the sample results:',
  'wizard.sampleDone.byEntityTitle': 'Breakdown by entity',
  'wizard.sampleDone.proceedTitle': 'Do you want to go ahead with the full integration?',
  'wizard.sampleDone.proceedBody':
    "We'll import the rest of the courses, students and content. The sample course and students <b>aren't duplicated</b>: they're kept as they are and only what's missing is added. This can take several minutes depending on the size of your academy.",
  'wizard.sampleDone.stopHere': 'Stop here (keep only the sample)',
  'wizard.sampleDone.starting': 'Starting…',
  'wizard.sampleDone.proceed': 'Yes, run the full integration',

  'wizard.stats.source': 'Source',
  'wizard.stats.loaded': 'Loaded',
  'wizard.stats.skipped': 'Skipped',
  'wizard.stats.failed': 'Failed',

  'wizard.completeRun.title': 'Importing full integration…',
  'wizard.completeRun.description':
    "We're bringing over the rest of your academy. This can take several minutes.",

  'wizard.done.title': 'Migration finished',
  'wizard.done.fullReport': 'Full report (job {jobId})',
  'wizard.done.sampleOnly':
    'Only the sample was imported (job {jobId}). You can run the full integration later from the module dashboard.',
  'wizard.done.noReport': 'No report available.',
  'wizard.done.auditVerified': 'Audit chain: {count} events (✓ verified).',
  'wizard.done.auditAltered': 'Audit chain: {count} events (⚠ tampered).',

  'wizard.running.statusTitle': 'Current status',
  'wizard.running.status': 'Job <code>{jobId}</code> · {status}',
  'wizard.running.statusWithPhase':
    'Job <code>{jobId}</code> · {status} · phase <code>{phase}</code>',
  'wizard.running.autoRefresh':
    "This screen refreshes automatically every {seconds} seconds. You can close your browser: the job keeps running in the background and when you come back you'll see the report in the module dashboard.",

  'wizard.notice.warning': 'Important',
  'wizard.notice.error': 'Error',
  'wizard.notice.info': 'Info',

  'monitor.status.pending': 'Pending',
  'monitor.status.preflight': 'Preflight',
  'monitor.status.extracting': 'Extracting',
  'monitor.status.transforming': 'Transforming',
  'monitor.status.loading': 'Loading',
  'monitor.status.reconciling': 'Reconciling',
  'monitor.status.completed': 'Completed',
  'monitor.status.failed': 'Failed',
  'monitor.status.cancelled': 'Cancelled',

  'monitor.cursor.extract': 'Extract: {current} page {page}',
  'monitor.cursor.extractWithTotals': 'Extract: {current} page {page} (totals: {totals})',
  'monitor.cursor.transform': 'Transform: {current} ({done} entities completed)',
  'monitor.cursor.load': 'Load: {current} ({done} entities completed)',

  'monitor.error.loadJobs': 'Error loading jobs',
  'monitor.error.cancelJob': 'Error cancelling job',
  'monitor.loading': 'Loading jobs…',
  'monitor.loadErrorLine': 'Error loading jobs: {error}',
  'monitor.retry': 'Retry',
  'monitor.empty': 'There are no migrations for this tenant yet.',
  'monitor.emptyHint': 'Create one from the <strong>{tab}</strong> tab.',
  'monitor.activeSummary': '{count} migration(s) in progress · auto-refresh every {seconds}s',
  'monitor.noActive': 'No active migrations right now',
  'monitor.refresh': '↻ Refresh',
  'monitor.activeTitle': 'In progress',
  'monitor.historyTitle': 'History',
  'monitor.copyId': 'Copy full ID',
  'monitor.running': 'running',
  'monitor.finished': '· finished {date}',
  'monitor.hide': 'Hide',
  'monitor.showDetail': 'Details',
  'monitor.cancel': 'Cancel',
  'monitor.cancelDialog.title': 'Cancel this migration?',
  'monitor.cancelDialog.body':
    'The job will stop progressing after the current tick. Whatever was already loaded into the core is kept (idempotency by externalRef lets you re-run a new migration without duplicates). Staging rows are kept for auditing according to retentionDays.',
  'monitor.cancelDialog.confirm': 'Yes, cancel',

  'monitor.detail.loading': 'Loading details…',
  'monitor.detail.reconciliationTitle': 'Reconciliation by entity',
  'monitor.detail.colStaged': 'Staged',
  'monitor.detail.colValid': 'Valid',
  'monitor.detail.colLoaded': 'Loaded',
  'monitor.detail.colSkipped': 'Skipped',
  'monitor.detail.colFailed': 'Failed',
  'monitor.detail.total': 'Total',
  'monitor.detail.auditVerified': 'Audit chain: {count} event(s) · ✓ integrity verified',
  'monitor.detail.auditUnverifiable':
    "Audit chain: {count} event(s) · ✗ integrity can't be verified",
  'monitor.detail.noReconciliation':
    "No reconciliation data yet. The report is generated in the job's final phase.",

  'monitor.dlq.title': 'Dead Letter Queue',
  'monitor.dlq.count': '({total} row(s), showing {shown})',
  'monitor.dlq.empty': 'No errors logged — all rows processed OK.',
  'monitor.dlq.colSourceId': 'Source ID',
  'monitor.dlq.colPhase': 'Phase',
  'monitor.dlq.colError': 'Error',
  'monitor.dlq.colMessage': 'Message',
};

const pt: Record<MessageKey, string> = {
  'common.back': 'Voltar',
  'common.continue': 'Continuar',
  'common.error': 'Erro',
  'common.entity': 'Entidade',

  'admin.tabs.wizard': 'Criar migração',
  'admin.tabs.monitor': 'Monitor de migrações',

  'entity.courses': 'Cursos',
  'entity.lessons': 'Aulas',
  'entity.topics': 'Tópicos',
  'entity.quizzes': 'Quizzes',
  'entity.groups': 'Grupos',
  'entity.users': 'Alunos',

  'wizard.error.jobCancelled': 'Job cancelado',
  'wizard.error.jobFailed': 'O job falhou',
  'wizard.error.preflightFailed': 'O preflight falhou',
  'wizard.error.connection': 'Erro de conexão',
  'wizard.error.createJob': 'Não foi possível criar o job',

  'wizard.scope.courses.label': 'Apenas cursos',
  'wizard.scope.courses.help':
    'Importa o conteúdo: cursos, aulas, tópicos e quizzes. Não cria usuários nem matrículas.',
  'wizard.scope.enrolledStudents.label': 'Apenas alunos matriculados em cursos',
  'wizard.scope.enrolledStudents.help':
    'Importa os alunos com pelo menos uma matrícula e as inscrições deles. Exige que os cursos já tenham sido migrados (modo diferido).',
  'wizard.scope.all.label': 'Tudo',
  'wizard.scope.all.help': 'Importa conteúdo + usuários + matrículas. É a opção completa.',

  'wizard.stepper.welcome': 'Início',
  'wizard.stepper.connect': 'Conectar',
  'wizard.stepper.preflight': 'Resumo',
  'wizard.stepper.options': 'Opções',
  'wizard.stepper.sample': 'Teste',
  'wizard.stepper.complete': 'Completa',

  'wizard.welcome.title': 'Pronto para trazer sua escola para a Didacta?',
  'wizard.welcome.description':
    'Vamos guiar você passo a passo. Você precisa de uma senha de aplicativo (Application Password) do seu WordPress (mostramos como criar) e de alguns minutos. Seu site atual não é alterado.',
  'wizard.welcome.reqAdmin': 'Acesso de administrador ao seu WordPress com LearnDash.',
  'wizard.welcome.reqAppPassword': 'Senha de aplicativo (não a senha normal).',
  'wizard.welcome.reqPublic': 'Site acessível publicamente (HTTPS).',
  'wizard.welcome.start': 'Começar',

  'wizard.connect.title': 'Conectar ao seu WordPress',
  'wizard.connect.description': 'URL do site + senha de aplicativo.',
  'wizard.connect.urlLabel': 'URL do seu WordPress',
  'wizard.connect.urlPlaceholder': 'https://minhaescola.com.br',
  'wizard.connect.userLabel': 'Usuário administrador',
  'wizard.connect.appPasswordLabel': 'Senha de aplicativo',
  'wizard.connect.checking': 'Verificando...',
  'wizard.connect.submit': 'Verificar e continuar',

  'wizard.preflight.title': 'Isto é o que vamos migrar',
  'wizard.preflight.sourceFallback': 'Origem',
  'wizard.preflight.latency': 'latência {ms} ms',
  'wizard.preflight.samplesTitle': 'Amostras das últimas 5 entidades por tipo',
  'wizard.preflight.samplesNote':
    'Mostramos as 5 mais recentes por tipo (inclui rascunhos, privadas e agendadas). Para revisar tudo em detalhe, abra o seu WordPress de origem — a migração vai trazer o que corresponder às opções que você escolher no próximo passo.',
  'wizard.preflight.warningsTitle': 'Avisos da origem',
  'wizard.preflight.untitled': '(sem título · id={id})',

  'wizard.options.title': 'Como você quer fazer a migração?',
  'wizard.options.description': 'Os valores padrão são os mais seguros.',
  'wizard.options.whatLabel': 'O que você quer migrar?',
  'wizard.options.coursesFirstTitle': 'Migre os cursos primeiro',
  'wizard.options.coursesFirstBody':
    'Este modo traz apenas alunos e matrículas. As inscrições são vinculadas aos cursos que já existem na Didacta: se um curso ainda não foi migrado, essa matrícula fica registrada como ocorrência no relatório. Rode antes uma migração de “{coursesOnly}” (ou “{everything}”).',
  'wizard.options.passwordsLabel': 'Senhas',
  'wizard.options.passwordActivation': 'Enviar e-mail de ativação (recomendado)',
  'wizard.options.passwordPreserve': 'Manter a senha original (avançado)',
  'wizard.options.imagesLabel': 'Imagens',
  'wizard.options.copyImages': 'Copiar imagens para a Didacta (recomendado)',
  'wizard.options.howTitle': 'Como vai funcionar',
  'wizard.options.howBody':
    'Primeiro fazemos um <b>teste</b>: importamos um curso da sua escola com até {users} alunos para você conferir se está tudo certo na Didacta. Se gostar do resultado, perguntamos se você quer seguir com a <b>integração completa</b>; o curso do teste não é importado de novo (reaproveitamos o que já foi carregado), só adicionamos o que falta.',
  'wizard.options.starting': 'Iniciando...',
  'wizard.options.startSample': 'Começar o teste',

  'wizard.sampleRun.title': 'Importando amostra…',
  'wizard.sampleRun.description':
    'Estamos trazendo {courses} curso aleatório e até {users} alunos para você conferir o resultado.',

  'wizard.sampleDone.title': 'Teste concluído',
  'wizard.sampleDone.description': 'Estes são os resultados da amostra:',
  'wizard.sampleDone.byEntityTitle': 'Detalhe por entidade',
  'wizard.sampleDone.proceedTitle': 'Quer seguir com a integração completa?',
  'wizard.sampleDone.proceedBody':
    'Vamos importar o restante dos cursos, alunos e conteúdos. O curso e os alunos da amostra <b>não são duplicados</b>: ficam como estão e só é adicionado o que falta. Esta operação pode levar vários minutos, dependendo do tamanho da sua escola.',
  'wizard.sampleDone.stopHere': 'Parar aqui (fico só com a amostra)',
  'wizard.sampleDone.starting': 'Iniciando…',
  'wizard.sampleDone.proceed': 'Sim, fazer a integração completa',

  'wizard.stats.source': 'Origem',
  'wizard.stats.loaded': 'Carregados',
  'wizard.stats.skipped': 'Ignorados',
  'wizard.stats.failed': 'Com falha',

  'wizard.completeRun.title': 'Importando a integração completa…',
  'wizard.completeRun.description':
    'Estamos trazendo o restante da sua escola. Pode levar vários minutos.',

  'wizard.done.title': 'Migração concluída',
  'wizard.done.fullReport': 'Relatório completo (job {jobId})',
  'wizard.done.sampleOnly':
    'Só a amostra foi importada (job {jobId}). Você pode iniciar a integração completa mais tarde no painel do módulo.',
  'wizard.done.noReport': 'Nenhum relatório disponível.',
  'wizard.done.auditVerified': 'Cadeia de auditoria: {count} eventos (✓ verificada).',
  'wizard.done.auditAltered': 'Cadeia de auditoria: {count} eventos (⚠ alterada).',

  'wizard.running.statusTitle': 'Status atual',
  'wizard.running.status': 'Job <code>{jobId}</code> · {status}',
  'wizard.running.statusWithPhase':
    'Job <code>{jobId}</code> · {status} · fase <code>{phase}</code>',
  'wizard.running.autoRefresh':
    'Esta tela é atualizada automaticamente a cada {seconds} segundos. Você pode fechar o navegador: o job continua em segundo plano e, ao voltar, você verá o relatório no painel do módulo.',

  'wizard.notice.warning': 'Importante',
  'wizard.notice.error': 'Erro',
  'wizard.notice.info': 'Info',

  'monitor.status.pending': 'Pendente',
  'monitor.status.preflight': 'Preflight',
  'monitor.status.extracting': 'Extraindo',
  'monitor.status.transforming': 'Transformando',
  'monitor.status.loading': 'Carregando',
  'monitor.status.reconciling': 'Reconciliando',
  'monitor.status.completed': 'Concluído',
  'monitor.status.failed': 'Com falha',
  'monitor.status.cancelled': 'Cancelado',

  'monitor.cursor.extract': 'Extract: {current} página {page}',
  'monitor.cursor.extractWithTotals': 'Extract: {current} página {page} (totais: {totals})',
  'monitor.cursor.transform': 'Transform: {current} ({done} entidades concluídas)',
  'monitor.cursor.load': 'Load: {current} ({done} entidades concluídas)',

  'monitor.error.loadJobs': 'Erro ao carregar os jobs',
  'monitor.error.cancelJob': 'Erro ao cancelar o job',
  'monitor.loading': 'Carregando jobs…',
  'monitor.loadErrorLine': 'Erro ao carregar os jobs: {error}',
  'monitor.retry': 'Tentar novamente',
  'monitor.empty': 'Ainda não há migrações para este tenant.',
  'monitor.emptyHint': 'Crie uma na aba <strong>{tab}</strong>.',
  'monitor.activeSummary':
    '{count} migração(ões) em andamento · atualização automática a cada {seconds}s',
  'monitor.noActive': 'Nenhuma migração ativa no momento',
  'monitor.refresh': '↻ Atualizar',
  'monitor.activeTitle': 'Em andamento',
  'monitor.historyTitle': 'Histórico',
  'monitor.copyId': 'Copiar ID completo',
  'monitor.running': 'em execução',
  'monitor.finished': '· terminou {date}',
  'monitor.hide': 'Ocultar',
  'monitor.showDetail': 'Detalhes',
  'monitor.cancel': 'Cancelar',
  'monitor.cancelDialog.title': 'Cancelar esta migração?',
  'monitor.cancelDialog.body':
    'O job vai parar de avançar depois do tick atual. O que já foi carregado no core é mantido (a idempotência por externalRef permite rodar uma nova migração sem duplicar). As linhas em staging ficam guardadas para auditoria conforme o retentionDays.',
  'monitor.cancelDialog.confirm': 'Sim, cancelar',

  'monitor.detail.loading': 'Carregando detalhes…',
  'monitor.detail.reconciliationTitle': 'Reconciliação por entidade',
  'monitor.detail.colStaged': 'Staged',
  'monitor.detail.colValid': 'Válidas',
  'monitor.detail.colLoaded': 'Carregadas',
  'monitor.detail.colSkipped': 'Ignoradas',
  'monitor.detail.colFailed': 'Com falha',
  'monitor.detail.total': 'Total',
  'monitor.detail.auditVerified':
    'Cadeia de auditoria: {count} evento(s) · ✓ integridade verificada',
  'monitor.detail.auditUnverifiable':
    'Cadeia de auditoria: {count} evento(s) · ✗ integridade não verificável',
  'monitor.detail.noReconciliation':
    'Ainda não há dados de reconciliação. O relatório é gerado na fase final do job.',

  'monitor.dlq.title': 'Dead Letter Queue',
  'monitor.dlq.count': '({total} linha(s), mostrando {shown})',
  'monitor.dlq.empty': 'Nenhum erro registrado — todas as linhas processadas OK.',
  'monitor.dlq.colSourceId': 'Source ID',
  'monitor.dlq.colPhase': 'Fase',
  'monitor.dlq.colError': 'Erro',
  'monitor.dlq.colMessage': 'Mensagem',
};

export const MESSAGES: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = {
  es,
  en,
  pt,
};

/** Locale de `Intl` con el que se formatea cada tabla si el tag activo no sirve. */
const CANONICAL_TAG: Record<Lang, string> = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' };

/**
 * Tabla que corresponde a un tag: `pt-*` → pt, `en-*` → en, cualquier otro
 * (incluido `es-AR`, `fr-FR` o nada) → es.
 */
export function resolveLang(tag: string | null | undefined): Lang {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'pt') return 'pt';
  if (base === 'en') return 'en';
  return 'es';
}

let activeTag: string | null = null;

/** Lo llama `AdminSurface` en cada render con el `useLocale()` del runtime. */
export function setActiveLocale(tag: string | null | undefined): void {
  activeTag = tag || null;
}

/**
 * Idioma del host cuando aún no ha pasado ningún render: `i18n.getLocale()`
 * del runtime 1.1.0 y, con un host 1.0.0, `<html lang>`. Va por `globalThis`
 * (en el navegador, `window`) para no depender de los tipos del DOM ni de
 * `_runtime`.
 */
function hostLocale(): string {
  const g = globalThis as {
    __didacta__?: { i18n?: { getLocale?: () => string } };
    document?: { documentElement?: { lang?: string } };
  };
  try {
    const fromRuntime = g.__didacta__?.i18n?.getLocale?.();
    if (fromRuntime) return fromRuntime;
  } catch {
    // Un runtime roto no debe dejar la pantalla sin textos: se sigue abajo.
  }
  return g.document?.documentElement?.lang ?? '';
}

/** Tag activo tal cual (`es-ES`, `es-AR`, `en-US`, `pt-BR`…), o `''`. */
export function activeLocale(): string {
  return activeTag ?? hostLocale();
}

export function currentLang(): Lang {
  return resolveLang(activeLocale());
}

/**
 * Locale para `Intl`: el tag activo si es válido y es del idioma que se pinta
 * (`es-AR` formatea como Argentina); si no (`fr-FR`, vacío, basura), el
 * canónico de la tabla, para que fechas y números vayan en el idioma del texto.
 */
export function intlLocale(): string {
  const tag = activeLocale();
  const lang = resolveLang(tag);
  if (tag.toLowerCase().startsWith(lang)) {
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? CANONICAL_TAG[lang];
    } catch {
      // Tag mal formado: se usa el canónico.
    }
  }
  return CANONICAL_TAG[lang];
}

export type MessageVars = Readonly<Record<string, string | number>>;

function formatVar(value: string | number): string {
  return typeof value === 'number' ? formatNumber(value) : value;
}

function interpolate(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : formatVar(value);
  });
}

/** Texto de `key` en el idioma activo, con `{marcadores}` sustituidos. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return interpolate(MESSAGES[currentLang()][key], vars);
}

/** Etiquetas que admiten los textos (y las únicas que se convierten en elementos). */
export type RichTag = 'b' | 'strong' | 'code';

export type RichPart = string | { tag: RichTag; text: string };

const RICH_RE = /<(b|strong|code)>([\s\S]*?)<\/\1>/g;

/**
 * Como `t()`, pero devuelve el texto troceado por etiquetas para pintarlas
 * como elementos (`i18n-rich.tsx`). Las etiquetas se buscan en la PLANTILLA y
 * los valores se sustituyen después: un dato que traiga `<b>` se pinta tal
 * cual, nunca como etiqueta.
 */
export function tParts(key: MessageKey, vars?: MessageVars): RichPart[] {
  const template = MESSAGES[currentLang()][key];
  const parts: RichPart[] = [];
  let last = 0;
  for (const m of template.matchAll(RICH_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(interpolate(template.slice(last, start), vars));
    parts.push({ tag: m[1] as RichTag, text: interpolate(m[2] ?? '', vars) });
    last = start + m[0].length;
  }
  if (last < template.length) parts.push(interpolate(template.slice(last), vars));
  return parts;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(intlLocale()).format(value);
}

/** Fecha y hora de un ISO (p. ej. `completedAt`). Vacío si no es una fecha. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(
    d,
  );
}

/**
 * Solo el día de una fecha de WordPress (`2024-05-01T10:00:00`, hora local del
 * sitio SIN zona). Se toma la parte `AAAA-MM-DD` y se formatea en UTC para que
 * la zona del navegador no la mueva de día. Si no tiene esa forma, se devuelve
 * tal cual.
 */
export function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(intlLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(d);
}
