'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AiTutorOffNotice } from '@/components/ai-tutor-off-notice';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AdminTutorCorrecciones,
  AdminTutorInforme,
  AdminTutorRevision,
  aiTutorApi,
} from '@/modules/ai-tutor';

/**
 * Calidad del tutor IA (/admin/ai/tutor).
 *
 * Tres pestañas que son un mismo ciclo: ves lo que se le pregunta y lo que
 * contesta (Revisión) → corriges lo que está mal, y esa corrección se convierte
 * en conocimiento que el tutor reutiliza (Conocimiento validado) → una vez al
 * mes miras qué se repite para decidir qué material grabar (Informe).
 *
 * Separada de /admin/ai/providers, que es donde se configura la clave del
 * proveedor: aquello es fontanería, esto es contenido.
 */
export default function AdminTutorIaPage(): React.JSX.Element {
  const t = useTranslations('adminEngagement');
  const [tab, setTab] = useState('revision');
  // Sin proveedor de IA el tutor no se enseña a nadie: aquí se dice y se
  // enlaza a donde se enciende.
  const [sinProveedor, setSinProveedor] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void aiTutorApi.status().then((s) => !cancelled && setSinProveedor(s.reason === 'NO_PROVIDER'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">{t('aiTutor.title')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('aiTutor.subtitle')}</p>
      </div>

      {sinProveedor ? <AiTutorOffNotice /> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="revision">{t('aiTutor.tabRevision')}</TabsTrigger>
          <TabsTrigger value="conocimiento">{t('aiTutor.tabKnowledge')}</TabsTrigger>
          <TabsTrigger value="informe">{t('aiTutor.tabReport')}</TabsTrigger>
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
