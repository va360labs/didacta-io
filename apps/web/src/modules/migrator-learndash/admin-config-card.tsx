'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/// Tab del panel `/admin/configuracion` para el módulo migrator-learndash.
/// Resumen del propósito + CTA al wizard real (vive en
/// `/admin/integraciones/migrator-learndash`).

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
            <Link href="/admin/integraciones/migrator-learndash">Abrir asistente de migración</Link>
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
