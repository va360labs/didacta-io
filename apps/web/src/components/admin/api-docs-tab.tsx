'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Admin · Integración API — documentación EN VIVO para integradores externos
 * (n8n, Zapier, una página de ventas…).
 *
 * A diferencia del Swagger de `/api/docs`, que es el contrato estático y
 * público, esta página está autenticada y muestra los **grupos de acceso y
 * cursos reales del tenant** con sus UUID copiables, y genera el payload exacto
 * de alta/baja seleccionándolos. Así no hay que copiar identificadores a mano.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { authStorage } from '@/lib/auth-storage';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { coursesApi, type Course } from '@/lib/courses';
import { communityApi, type CommunitySpace } from '@/modules/community';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/v1/inscribe',
    scope: 'enrollments:write',
    whatKey: 'docs.whatInscribe',
  },
  {
    method: 'POST',
    path: '/api/v1/inscribe/revoke',
    scope: 'enrollments:write',
    whatKey: 'docs.whatRevoke',
  },
  {
    method: 'GET',
    path: '/api/v1/inscribe/access-groups',
    scope: 'courses:read',
    whatKey: 'docs.whatGroups',
  },
  {
    method: 'GET',
    path: '/api/v1/inscribe/courses',
    scope: 'courses:read',
    whatKey: 'docs.whatCourses',
  },
  {
    method: 'POST',
    path: '/api/v1/community-api/posts',
    scope: 'community:post',
    whatKey: 'docs.whatCommunityPost',
  },
] as const;

function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useTranslations('adminApi');
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Icon name="check" size={14} /> : null}
      {done ? t('docs.copied') : label || t('docs.copy')}
    </Button>
  );
}

/** UUID en mono + botón de copiar, que es el 90% del uso de esta página. */
function UuidCell({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{id}</code>
      <CopyButton value={id} label="" />
    </span>
  );
}

/** Pestaña "Documentación" de /admin/api-keys. Antes `/admin/integraciones/api`. */
export function ApiDocsTab() {
  const t = useTranslations('adminApi');
  const [groups, setGroups] = useState<AccessGroupListItem[] | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [spaces, setSpaces] = useState<CommunitySpace[]>([]);
  const [pickedGroups, setPickedGroups] = useState<string[]>([]);
  const [pickedCourses, setPickedCourses] = useState<string[]>([]);
  // Tab del admin: siempre corre en el dominio del tenant, así que la base de
  // la API se deriva del origin actual (la fija el useEffect de abajo).
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') setBaseUrl(window.location.origin);
    const token = authStorage.getAccessToken();
    // Best-effort e independientes: si un módulo no está activo, esa tabla queda
    // vacía sin romper la página.
    void (async () => {
      if (token) {
        try {
          const res = await accessGroupsApi.list(token, 1, 50);
          setGroups(res.groups);
        } catch {
          setGroups([]);
        }
      } else {
        setGroups([]);
      }
      try {
        setCourses(await coursesApi.list());
      } catch {
        setCourses([]);
      }
      try {
        setSpaces(await communityApi.listSpaces());
      } catch {
        setSpaces([]);
      }
    })();
  }, []);

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  const payload = useMemo(() => {
    const body: Record<string, unknown> = { email: 'comprador@ejemplo.com', name: 'Ana Pérez' };
    if (pickedGroups.length) body['accessGroupIds'] = pickedGroups;
    if (pickedCourses.length) body['courseIds'] = pickedCourses;
    body['externalRef'] = 'wc_order_12345';
    return JSON.stringify(body, null, 2);
  }, [pickedGroups, pickedCourses]);

  const revokePayload = useMemo(() => {
    const body: Record<string, unknown> = { email: 'comprador@ejemplo.com' };
    if (pickedGroups.length) body['accessGroupIds'] = pickedGroups;
    if (pickedCourses.length) body['courseIds'] = pickedCourses;
    body['externalRef'] = 'wc_refund_998';
    body['reason'] = 'refund';
    return JSON.stringify(body, null, 2);
  }, [pickedGroups, pickedCourses]);

  const curl = useMemo(
    () =>
      `curl -X POST ${baseUrl}/api/v1/inscribe \\\n` +
      `  -H "Authorization: ApiKey lmsk_TU_CLAVE" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${payload.replace(/\n\s*/g, ' ')}'`,
    [baseUrl, payload],
  );

  const nothingPicked = pickedGroups.length === 0 && pickedCourses.length === 0;

  const communityCurl = useMemo(() => {
    const space = spaces[0]?.slug ?? 'general';
    const body = JSON.stringify({
      title: 'Novedades de la semana',
      body: 'Esta semana hemos publicado…',
      space,
      notifyAll: true,
    });
    return (
      `curl -X POST ${baseUrl}/api/v1/community-api/posts \\\n` +
      `  -H "Authorization: ApiKey lmsk_TU_CLAVE" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${body}'`
    );
  }, [baseUrl, spaces]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold tracking-tight">{t('docs.title')}</h2>
        <p className="text-text-muted">{t('docs.subtitle')}</p>
      </header>

      {/* ── Autenticación ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('docs.authTitle')}</CardTitle>
          <CardDescription>{t('docs.authDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs">
              Authorization: ApiKey lmsk_…
            </code>
            <CopyButton value="Authorization: ApiKey lmsk_TU_CLAVE" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-muted">{t('docs.baseLabel')}</span>
            <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs">
              {baseUrl || '…'}
            </code>
            <CopyButton value={baseUrl} label="" />
          </div>
          <div className="flex flex-wrap gap-3 border-t border-border pt-3 text-sm">
            <Link href="/admin/api-keys" className="font-semibold text-brand-700 hover:underline">
              {t('docs.createKeyLink')}
            </Link>
            <a
              href="/api/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-brand-700 hover:underline"
            >
              {t('docs.swaggerLink')}
            </a>
          </div>
        </CardContent>
      </Card>

      {/* ── Endpoints ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('docs.endpointsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-text-subtle">
                <tr>
                  <th className="px-4 py-2">{t('docs.colMethod')}</th>
                  <th className="px-4 py-2">{t('docs.colPath')}</th>
                  <th className="px-4 py-2">{t('docs.colScope')}</th>
                  <th className="px-4 py-2">{t('docs.colWhat')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {ENDPOINTS.map((e) => (
                  <tr key={e.path + e.method}>
                    <td className="px-4 py-2">
                      <Badge className="bg-brand-700 text-white">{e.method}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{e.path}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-muted">{e.scope}</td>
                    <td className="px-4 py-2 text-text-muted">{t(e.whatKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Grupos de acceso (live) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('docs.groupsTitle')}</CardTitle>
          <CardDescription>{t('docs.groupsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {groups === null ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : groups.length === 0 ? (
            <p className="p-4 text-sm text-text-muted">
              {t.rich('docs.groupsEmpty', {
                link: (chunks) => (
                  <Link
                    href="/admin/grupos-acceso"
                    className="font-semibold text-brand-700 underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-text-subtle">
                  <tr>
                    <th className="px-4 py-2">{t('docs.colUse')}</th>
                    <th className="px-4 py-2">{t('docs.colName')}</th>
                    <th className="px-4 py-2">{t('docs.colKind')}</th>
                    <th className="px-4 py-2">{t('docs.colCourses')}</th>
                    <th className="px-4 py-2">{t('docs.colUuid')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {groups.map((g) => (
                    <tr key={g.id}>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          aria-label={t('docs.useGroupAria', { name: g.name })}
                          checked={pickedGroups.includes(g.id)}
                          onChange={() => setPickedGroups((p) => toggle(p, g.id))}
                        />
                      </td>
                      <td className="px-4 py-2 font-medium">{g.name}</td>
                      <td className="px-4 py-2 text-xs text-text-muted">{g.kind}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {g.kind === 'ALL_COURSES' ? t('docs.allCourses') : (g.courseCount ?? 0)}
                      </td>
                      <td className="px-4 py-2">
                        <UuidCell id={g.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cursos (live) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('docs.coursesTitle')}</CardTitle>
          <CardDescription>
            {t.rich('docs.coursesDescription', {
              strong: (chunks) => <strong>{chunks}</strong>,
              code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {courses === null ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : courses.length === 0 ? (
            <p className="p-4 text-sm text-text-muted">{t('docs.coursesEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-text-subtle">
                  <tr>
                    <th className="px-4 py-2">{t('docs.colUse')}</th>
                    <th className="px-4 py-2">{t('docs.colTitle')}</th>
                    <th className="px-4 py-2">{t('docs.colStatus')}</th>
                    <th className="px-4 py-2">{t('docs.colUuid')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {courses.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          aria-label={t('docs.useCourseAria', { title: c.title })}
                          checked={pickedCourses.includes(c.id)}
                          onChange={() => setPickedCourses((p) => toggle(p, c.id))}
                        />
                      </td>
                      <td className="px-4 py-2 font-medium">{c.title}</td>
                      <td className="px-4 py-2">
                        <Badge
                          className={
                            c.status === 'PUBLISHED'
                              ? 'bg-success-600 text-white'
                              : 'border-border-strong text-text-muted'
                          }
                        >
                          {c.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        <UuidCell id={c.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Payloads generados ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('docs.payloadTitle')}</CardTitle>
          <CardDescription>
            {nothingPicked ? t('docs.payloadPickPrompt') : t('docs.payloadGenerated')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-uppercase text-xs text-text-subtle">
                {t('docs.enrollLabel')}
              </span>
              <CopyButton value={payload} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
              {payload}
            </pre>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-uppercase text-xs text-text-subtle">
                {t('docs.revokeLabel')}
              </span>
              <CopyButton value={revokePayload} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
              {revokePayload}
            </pre>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-uppercase text-xs text-text-subtle">
                {t('docs.curlLabel')}
              </span>
              <CopyButton value={curl} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
              {curl}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* ── Publicar en la comunidad ── */}
      <Card data-testid="community-api-docs">
        <CardHeader>
          <CardTitle className="text-base">{t('docs.communityTitle')}</CardTitle>
          <CardDescription>
            {t.rich('docs.communityDescription', {
              codeChip: (chunks) => (
                <code className="rounded bg-surface-2 px-1 font-mono text-xs">{chunks}</code>
              ),
              strong: (chunks) => <strong>{chunks}</strong>,
              link: (chunks) => (
                <Link
                  href="/admin/comunidad/publicaciones-api"
                  className="font-semibold text-brand-700 hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-text-subtle">
                <tr>
                  <th className="py-2 pr-3">{t('docs.colField')}</th>
                  <th className="py-2 pr-3">{t('docs.colType')}</th>
                  <th className="py-2">{t('docs.colNotes')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft text-text-muted">
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">title</td>
                  <td className="py-2 pr-3">{t('docs.typeStringRequired')}</td>
                  <td className="py-2">{t('docs.noteTitle')}</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">body</td>
                  <td className="py-2 pr-3">{t('docs.typeStringRequired')}</td>
                  <td className="py-2">{t('docs.noteBody')}</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">space</td>
                  <td className="py-2 pr-3">{t('docs.typeStringOptional')}</td>
                  <td className="py-2">
                    {t('docs.noteSpace')}
                    {spaces.length > 0 ? (
                      <>
                        {' '}
                        {t('docs.noteSpaceYours')}{' '}
                        {spaces.map((s) => (
                          <code
                            key={s.id}
                            className="mr-1 rounded bg-surface-2 px-1 font-mono text-xs"
                          >
                            {s.slug}
                          </code>
                        ))}
                      </>
                    ) : null}
                    {t('docs.noteSpaceAlso')}{' '}
                    <code className="rounded bg-surface-2 px-1 font-mono text-xs">
                      GET /api/v1/community-api/spaces
                    </code>
                    .
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">tags</td>
                  <td className="py-2 pr-3">{t('docs.typeStringArrayOptional')}</td>
                  <td className="py-2">{t('docs.noteTags')}</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">notifyAll</td>
                  <td className="py-2 pr-3">{t('docs.typeBooleanOptional')}</td>
                  <td className="py-2">
                    {t.rich('docs.noteNotifyAll', {
                      codeChip: (chunks) => (
                        <code className="rounded bg-surface-2 px-1 font-mono text-xs">
                          {chunks}
                        </code>
                      ),
                    })}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">important</td>
                  <td className="py-2 pr-3">{t('docs.typeBooleanOptional')}</td>
                  <td className="py-2">{t('docs.noteImportant')}</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-mono text-xs">courseId</td>
                  <td className="py-2 pr-3">{t('docs.typeUuidOptional')}</td>
                  <td className="py-2">{t('docs.noteCourseId')}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-uppercase text-xs text-text-subtle">
                {t('docs.curlLabel')}
              </span>
              <CopyButton value={communityCurl} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
              {communityCurl}
            </pre>
          </div>

          <p className="text-xs text-text-subtle">
            {t.rich('docs.adminKeyNote', {
              code: (chunks) => (
                <code className="rounded bg-surface-2 px-1 font-mono">{chunks}</code>
              ),
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
