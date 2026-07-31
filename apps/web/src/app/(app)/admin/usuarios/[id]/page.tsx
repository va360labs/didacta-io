'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Esta ficha se fusionó con `/u/[id]`.
 *
 * Había dos páginas para la misma persona: el perfil público y esta ficha de
 * IAM. Con «pulsar el nombre desde cualquier sección lleva a su ficha», dos
 * destinos distintos era garantía de acabar en el equivocado — exactamente el
 * problema que ya costó el duplicado de `/inicio` contra `/comunidad`.
 *
 * Todo lo que había aquí (estado, roles, sesiones, suspender, reenviar el
 * email de contraseña) vive ahora en la pestaña «Acceso» del expediente, junto
 * a compras, formación, actividad, mensajes y sanciones. Los enlaces antiguos
 * siguen funcionando gracias a esta redirección.
 */
export default function AdminUserDetailRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  useEffect(() => {
    if (!id) return;
    router.replace(`/u/${encodeURIComponent(id)}?tab=acceso` as never);
  }, [id, router]);

  return (
    <div className="p-8 text-center text-sm text-text-muted">Abriendo la ficha del usuario…</div>
  );
}
