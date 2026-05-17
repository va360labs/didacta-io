/// Tab del panel `/admin/configuracion` para el módulo migrator-learndash.
/// Resumen del propósito + CTA al wizard real (vive en `/admin/integraciones/migrator-learndash`).
///
/// alpha.60: movido a modules/migrator-learndash/src/ui/ desde apps/web/.
/// Usa `<a href>` plain en lugar de Next.js `<Link>` porque el runtime
/// del host no expone Next.js a los bundles (y no debe — un módulo
/// publicado por un third-party puede no estar en un host Next.js).
/// Trade-off: el click hace full page navigation, no client-side route.
/// Para módulos que QUIEREN navigation suave, el host puede exponer un
/// helper `__didacta__.nav.navigate(href)` en una próxima iteración.

import { React, Card, CardContent, CardDescription, CardHeader, CardTitle, Button } from './_runtime';

export function MigratorAdminCard(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Migrar desde WordPress + LearnDash</CardTitle>
        <CardDescription>
          Importa toda tu academia LearnDash a Didacta paso a paso. Wizard guiado para administradores
          no técnicos: conectar con tu WordPress, ver qué hay, decidir cómo migrar y ejecutar con
          progreso en tiempo real.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc pl-6 text-sm text-muted-foreground">
          <li>Cursos, lecciones, temas, quizzes y preguntas.</li>
          <li>Alumnos, grupos y matrículas (con dedupe por email).</li>
          <li>Imágenes y archivos adjuntos.</li>
          <li>Progreso actual de los alumnos.</li>
          <li>Reporte auditable descargable al cierre.</li>
        </ul>
        <div className="flex gap-2">
          <Button asChild>
            <a href="/admin/integraciones/migrator-learndash">Abrir asistente de migración</a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Requiere licencia Enterprise con la capacidad <code>feat:migrators.learndash</code>.
          Tus datos en WordPress no se modifican; el migrador solo lee.
        </p>
      </CardContent>
    </Card>
  );
}
