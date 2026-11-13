'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useParams, useSearchParams } from 'next/navigation';
import { CommunityFeed } from '@/components/community-feed';

/**
 * URL canónica y compartible de un post: renderiza el feed de la comunidad con
 * el post abierto en modal (misma experiencia que abrirlo desde el feed). Si el
 * usuario no está logueado, el layout de (app) lo manda a /signin y esta ruta
 * se restaura tras el login (ver lib/post-login-redirect).
 *
 * `?comment=<id>` (desde una notificación) enfoca ese comentario y, si es un
 * comentario raíz, abre su composer de respuesta directamente.
 */
export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const focusCommentId = useSearchParams().get('comment') ?? undefined;

  if (!params?.id) return null;

  return <CommunityFeed initialPostId={params.id} focusCommentId={focusCommentId} />;
}
