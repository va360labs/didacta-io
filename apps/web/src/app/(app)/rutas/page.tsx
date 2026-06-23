import Link from 'next/link';

const RUTAS = [
  {
    id: 'onboarding',
    name: 'Onboarding ACME',
    description: 'Ruta de incorporación obligatoria — primeras 2 semanas',
    courses: 3,
    duration: '4 h',
    progress: 60,
    required: true,
  },
  {
    id: 'liderazgo',
    name: 'Liderazgo 360°',
    description: 'De fundamentos a conversaciones difíciles y toma de decisiones',
    courses: 4,
    duration: '8 h',
    progress: 40,
    required: false,
  },
  {
    id: 'comunicacion',
    name: 'Comunicación profesional',
    description: 'Escucha activa, comunicación escrita y presentaciones de alto impacto',
    courses: 3,
    duration: '6 h',
    progress: 0,
    required: false,
  },
];

export default function RutasPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Rutas de aprendizaje</h1>
        <p className="mt-1 text-sm text-text-muted">
          Itinerarios estructurados para avanzar paso a paso
        </p>
      </div>

      <div className="space-y-4">
        {RUTAS.map((r) => (
          <div key={r.id} className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-text">{r.name}</h2>
                  {r.required && (
                    <span className="rounded-full bg-(--didacta-coral)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-coral)">
                      Obligatoria
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-text-muted">{r.description}</p>
                <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
                  <span>{r.courses} cursos</span>
                  <span>{r.duration}</span>
                </div>
              </div>
              <Link
                href="/cursos"
                className="shrink-0 rounded-lg border border-(--didacta-trust) px-4 py-2 text-sm font-semibold text-(--didacta-trust) hover:bg-(--didacta-trust)/10"
              >
                {r.progress > 0 ? 'Continuar' : 'Empezar'}
              </Link>
            </div>
            {r.progress > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1 flex justify-between text-xs text-text-muted">
                  <span>Progreso</span>
                  <span>{r.progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-(--didacta-trust)"
                    style={{ width: `${r.progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
