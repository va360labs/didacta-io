'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Auditoría de publicaciones creadas VÍA API (`POST /community-api/posts`,
/// autenticadas con API key — scope `community:post`). Lista los posts con
/// `source='api'` agrupados por autor (el dueño de la key que publicó), con
/// enlace al post real en el feed. Las claves se gestionan en /admin/api-keys
/// y el endpoint está documentado en /admin/integraciones/api.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { communityApi, type Post } from '@/modules/community';

function dateLabel(iso: string): string {
  return formatDate(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminPublicacionesApiPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    communityApi
      .listPosts({ source: 'api', limit: 100 })
      .then((rows) => {
        if (!cancelled) setPosts(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(apiErrorMessage(e, tErrors));
      });
    return () => {
      cancelled = true;
    };
  }, [tErrors]);

  /** Agrupación por autor (dueño de la API key que publicó). */
  const byAuthor = useMemo(() => {
    if (!posts) return [];
    const groups = new Map<string, { name: string; posts: Post[] }>();
    for (const post of posts) {
      const entry = groups.get(post.authorId) ?? {
        name: post.authorDisplayName ?? post.authorId,
        posts: [],
      };
      entry.posts.push(post);
      groups.set(post.authorId, entry);
    }
    return [...groups.values()].sort((a, b) => b.posts.length - a.posts.length);
  }, [posts]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">{t('apiPosts.title')}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t.rich('apiPosts.description', {
            code: (chunks) => <code className="rounded bg-surface-2 px-1">{chunks}</code>,
            keysLink: (chunks) => (
              <Link href="/admin/api-keys" className="text-brand-700 hover:underline">
                {chunks}
              </Link>
            ),
            docsLink: (chunks) => (
              <Link href="/admin/api-keys?tab=docs" className="text-brand-700 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {posts === null ? (
        <div className="space-y-2">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-32 w-full" />
        </div>
      ) : byAuthor.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-text-subtle">{t('apiPosts.empty')}</CardContent>
        </Card>
      ) : (
        byAuthor.map((group) => (
          <Card key={group.name} data-testid="api-posts-author-group">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {group.name}
                <Badge variant="info">
                  {t('apiPosts.postCount', { count: group.posts.length })}
                </Badge>
              </CardTitle>
              <CardDescription>{t('apiPosts.viaApiKey')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border-soft">
                {group.posts.map((post) => (
                  <li key={post.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="shrink-0 text-xs text-text-subtle">
                      {dateLabel(post.createdAt)}
                    </span>
                    <Link
                      href={`/comunidad/${post.id}`}
                      className="min-w-0 flex-1 truncate font-semibold text-text hover:text-brand-700 hover:underline"
                    >
                      {post.title}
                    </Link>
                    {post.tags.map((tag) => (
                      <Badge key={tag} variant="muted">
                        #{tag}
                      </Badge>
                    ))}
                    {post.hiddenAt ? (
                      <Badge variant="danger">{t('apiPosts.hiddenBadge')}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
