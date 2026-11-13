'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { StartHere } from '@/components/simple-start/start-here';
import { authStorage } from '@/lib/auth-storage';

/**
 * «Empieza aquí» (modo sencillo): el inicio del creador hasta su primera
 * venta; después, su resumen. Solo para quien administra el aula.
 */
export default function EmpiezaPage() {
  const router = useRouter();
  const isAdmin = (authStorage.getSession()?.user.roles ?? []).some(
    (r) => r === 'tenant_admin' || r === 'super_admin',
  );
  useEffect(() => {
    if (!isAdmin) router.replace('/comunidad');
  }, [isAdmin, router]);
  if (!isAdmin) return null;
  return <StartHere />;
}
