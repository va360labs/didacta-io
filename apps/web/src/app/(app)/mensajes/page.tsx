'use client';

export default function MensajesPage() {
  return (
    <div
      className="flex overflow-hidden rounded-xl border border-border bg-surface"
      style={{ height: 'calc(100vh - 9rem)' }}
    >
      {/* Lista de conversaciones (vacía) */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-4">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-bold text-text">Mensajes</h1>
            <button
              type="button"
              className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              aria-label="Nueva conversación"
            >
              <svg
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <svg
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="shrink-0 text-text-muted"
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              placeholder="Buscar conversaciones…"
              className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-sm text-text-muted">No tienes conversaciones todavía.</p>
        </div>
      </div>

      {/* Área de chat vacía */}
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <p className="text-base font-semibold text-text">Mensajes directos</p>
        <p className="text-sm text-text-muted">Selecciona una conversación o inicia una nueva.</p>
      </div>
    </div>
  );
}
