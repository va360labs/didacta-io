export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col items-start justify-center gap-6 p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-neutral-500">VA360 LABS</p>
        <h1 className="mt-2 text-5xl font-semibold tracking-tight">LearnShip</h1>
        <p className="mt-3 text-lg text-neutral-600 dark:text-neutral-400">
          Plataforma LMS modular. Fase 0 — Discovery técnico.
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-500">Estado</h2>
        <p className="mt-2 text-sm">
          Esqueleto inicial. Los módulos de producto (cursos, learning, assessments, certificates,
          zoom-live, community, fundae, ai-tutor, ...) aún no están activos.
        </p>
      </section>

      <footer className="mt-auto pt-8 text-xs text-neutral-500">
        Proprietary © 2026 VA360 LABS S.L.
      </footer>
    </main>
  );
}
