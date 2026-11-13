'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { adminUsersApi, type UserListItem } from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';
import { formatDate } from '@/lib/i18n/format';
import { simpleModeApi } from '@/lib/simple-mode';
import { cn } from '@/lib/utils';
import { onlyStudents, shareUrl } from './helpers';

const PAGE = 50;

function initials(u: UserListItem): string {
  const base = u.name?.trim() || u.email;
  return base
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * «Alumnos» del MODO SENCILLO: quién está dentro y cómo traer a más (invitar
 * por correo o compartir el enlace de venta). Reutiliza el listado de
 * usuarios de la administración; la ficha de cada persona es la de siempre.
 */
export function SimpleStudents() {
  const t = useTranslations('modoSencilloGestion.alumnos');
  const [items, setItems] = useState<UserListItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    async (p: number, q: string) => {
      const token = authStorage.getAccessToken();
      if (!token) return;
      try {
        const res = await adminUsersApi.list(token, {
          search: q.trim() || undefined,
          page: p,
          limit: PAGE,
        });
        const students = onlyStudents(res.items);
        setItems((prev) => (p === 1 ? students : [...(prev ?? []), ...students]));
        setHasMore(res.hasMore);
        setPage(res.page);
        setError(null);
      } catch {
        setError(t('cargaError'));
      }
    },
    [t],
  );

  useEffect(() => {
    simpleModeApi
      .startHere()
      .then((v) => setLink(shareUrl(window.location.origin, v.salePath)))
      .catch(() => setLink(null));
  }, [load]);

  useEffect(() => {
    const id = setTimeout(() => void load(1, search), 300);
    return () => clearTimeout(id);
  }, [search, load]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace sigue visible */
    }
  }

  const empty = items !== null && items.length === 0 && !search.trim();

  return (
    <div className="mx-auto max-w-[880px]" data-testid="alumnos-sencillo">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text">
            {t('titulo')}
          </h1>
          <p className="mt-1 text-text-muted">{t('sub')}</p>
        </div>
        <Link
          href="/admin/users/invite"
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
        >
          <Icon name="mail" size={17} />
          {t('invitar')}
        </Link>
      </header>

      <section className="mt-6 rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-[15px] font-bold text-text">{t('compartirTitulo')}</h2>
        {link ? (
          <>
            <p className="mt-1 text-sm text-text-muted">{t('compartirTexto')}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <span className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-bg-subtle px-3 text-[15px] text-text">
                <Icon name="link" size={16} />
                <span className="truncate">{link.replace(/^https?:\/\//, '')}</span>
              </span>
              <button
                type="button"
                onClick={() => void copy()}
                className="h-11 rounded-xl bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700"
              >
                {copied ? t('copiado') : t('copiar')}
              </button>
            </div>
          </>
        ) : link === null ? (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted">
            <span>{t('sinEnlaceTexto')}</span>
            <Link href="/start" className="font-semibold text-brand-600 hover:underline">
              {t('sinEnlaceBoton')}
            </Link>
          </div>
        ) : (
          <div className="skeleton mt-3 h-11 w-full" />
        )}
      </section>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {error}
        </p>
      ) : null}

      {empty ? (
        <section className="mt-6 rounded-2xl border border-border bg-surface px-6 py-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-700">
            <Icon name="users" size={24} />
          </span>
          <h2 className="mt-4 text-lg font-bold text-text">{t('vacioTitulo')}</h2>
          <p className="mx-auto mt-2 max-w-[54ch] text-text-muted">{t('vacioTexto')}</p>
          <Link
            href="/admin/users/invite"
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
          >
            <Icon name="mail" size={17} />
            {t('invitar')}
          </Link>
        </section>
      ) : (
        <section className="mt-6 rounded-2xl border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="text-base font-bold text-text">{t('lista')}</h2>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('buscar')}
              aria-label={t('buscar')}
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-text outline-none focus:border-brand-600 sm:w-64"
            />
          </div>
          {items === null ? (
            <div className="skeleton m-4 h-24" />
          ) : (
            <ul>
              {items.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-[13px] font-bold text-white">
                    {initials(u)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-text">
                      {u.name?.trim() || u.email}
                    </div>
                    <div className="truncate text-sm text-text-subtle">
                      {u.lastLoginAt
                        ? t('entro', { fecha: formatDate(u.createdAt, { dateStyle: 'medium' }) })
                        : t('nuncaEntro')}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'hidden rounded-full px-2.5 py-0.5 text-xs font-bold sm:inline',
                      u.status === 'ACTIVE'
                        ? 'bg-success-50 text-success-700'
                        : 'bg-bg-subtle text-text-subtle',
                    )}
                  >
                    {t(`estado.${u.status}` as 'estado.ACTIVE')}
                  </span>
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="text-sm font-semibold text-brand-600 hover:underline"
                  >
                    {t('verFicha')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {hasMore ? (
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                onClick={() => void load(page + 1, search)}
                className="text-sm font-semibold text-brand-600 hover:underline"
              >
                {t('masResultados')}
              </button>
            </div>
          ) : null}
        </section>
      )}

      <Link
        href="/admin/access-groups"
        className="mt-4 flex items-center gap-3 rounded-2xl bg-bg-subtle p-4 text-sm hover:bg-border-soft"
      >
        <Icon name="lock" size={18} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-text">{t('quienVe')}</span>
          <span className="text-text-muted">{t('quienVeAyuda')}</span>
        </span>
        <Icon name="chevron-right" size={16} />
      </Link>
    </div>
  );
}
