/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { Notification } from '@/lib/notifications';
import { filterNotifications, MENTION_TEMPLATE } from './simple-bell';

function n(id: string, templateKey: string): Notification {
  return {
    id,
    tenantId: 't',
    userId: 'u',
    channel: 'IN_APP',
    templateKey,
    subject: null,
    body: '',
    metadata: {},
    readAt: null,
    sentAt: null,
    failedAt: null,
    failureReason: null,
    createdAt: '2026-11-12T10:00:00.000Z',
  };
}

describe('campanita del modo sencillo', () => {
  const lista = [
    n('1', MENTION_TEMPLATE),
    n('2', 'community.comment.on_post'),
    n('3', MENTION_TEMPLATE),
  ];

  it('«Menciones» deja solo las menciones (sustituye a la página «Mis menciones»)', () => {
    expect(filterNotifications(lista, 'mentions').map((x) => x.id)).toEqual(['1', '3']);
  });

  it('«Todas» no filtra nada', () => {
    expect(filterNotifications(lista, 'all')).toHaveLength(3);
  });
});
