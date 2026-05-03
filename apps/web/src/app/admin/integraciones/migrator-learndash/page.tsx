import * as React from 'react';
import { MigratorWizard } from '@/modules/migrator-learndash';

export const metadata = {
  title: 'Migrar desde LearnDash · Didacta',
  description: 'Asistente para migrar tu academia WordPress + LearnDash a Didacta.',
};

export default function MigratorLearndashPage(): React.ReactElement {
  return (
    <div className="container mx-auto max-w-3xl py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Migrar desde WordPress + LearnDash</h1>
        <p className="text-sm text-muted-foreground">
          Asistente paso a paso para administradores. Tu sitio actual no se modifica.
        </p>
      </div>
      <MigratorWizard />
    </div>
  );
}
