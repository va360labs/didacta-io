'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AdminTutorCorrecciones, AdminTutorInforme, AdminTutorRevision } from '@/modules/ai-tutor';

/**
 * Calidad del tutor IA (/admin/ia/tutor).
 *
 * Tres pestañas que son un mismo ciclo: ves lo que se le pregunta y lo que
 * contesta (Revisión) → corriges lo que está mal, y esa corrección se convierte
 * en conocimiento que el tutor reutiliza (Conocimiento validado) → una vez al
 * mes miras qué se repite para decidir qué material grabar (Informe).
 *
 * Separada de /admin/ia/providers, que es donde se configura la clave del
 * proveedor: aquello es fontanería, esto es contenido.
 */
export default function AdminTutorIaPage(): React.JSX.Element {
  const [tab, setTab] = useState('revision');

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">Tutor IA</h1>
        <p className="mt-1 text-sm text-text-muted">
          Qué le preguntan tus alumnos al tutor, qué les responde y qué hay que corregir. Lo que
          corrijas aquí lo usa el tutor en las siguientes respuestas, sin reindexar nada.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="revision">Revisión</TabsTrigger>
          <TabsTrigger value="conocimiento">Conocimiento validado</TabsTrigger>
          <TabsTrigger value="informe">Informe mensual</TabsTrigger>
        </TabsList>

        <TabsContent value="revision" className="mt-4">
          <AdminTutorRevision />
        </TabsContent>
        <TabsContent value="conocimiento" className="mt-4">
          <AdminTutorCorrecciones />
        </TabsContent>
        <TabsContent value="informe" className="mt-4">
          <AdminTutorInforme />
        </TabsContent>
      </Tabs>
    </div>
  );
}
