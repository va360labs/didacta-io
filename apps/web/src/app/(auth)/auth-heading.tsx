import type { ReactNode } from 'react';

/**
 * Encabezado de las pantallas de acceso. En la columna derecha del layout
 * `(auth)` no hay tarjeta: el formulario va plano sobre la superficie blanca,
 * así que el título y la descripción los pone cada página con este componente
 * (antes lo hacía `CardHeader`).
 */
export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="mb-7">
      <h1 className="font-display text-[1.75rem] font-extrabold leading-tight tracking-tight text-text">
        {title}
      </h1>
      {description ? (
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-text-muted">{description}</p>
      ) : null}
    </header>
  );
}
