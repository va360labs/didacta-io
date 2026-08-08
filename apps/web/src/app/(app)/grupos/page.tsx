'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { groupsApi, type Group, type GroupWithRole } from '@/lib/groups';

/** Identificador interno de la pestaña; el label sale del catálogo. */
type Tab = 'mine' | 'explore';

const TABS: { id: Tab; key: 'tabMisGrupos' | 'tabExplorar' }[] = [
  { id: 'mine', key: 'tabMisGrupos' },
  { id: 'explore', key: 'tabExplorar' },
];

function GroupCard({ group, myRole }: { group: Group; myRole?: string }) {
  const t = useTranslations('alumnoSocial');
  return (
    <Link
      href={`/grupos/${group.id}`}
      className="block rounded-xl border border-border bg-surface p-4 transition-shadow hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">{group.name}</p>
          {group.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{group.description}</p>
          )}
        </div>
        {myRole && (
          <span className="shrink-0 rounded-full bg-(--didacta-trust)/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-(--didacta-trust)">
            {myRole === 'owner' ? t('grupos.rolAdmin') : t('grupos.rolMiembro')}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {t('grupos.miembros', { count: group.memberCount })}
      </p>
    </Link>
  );
}

export default function GruposPage() {
  const t = useTranslations('alumnoSocial');
  const [tab, setTab] = useState<Tab>('mine');
  const [myGroups, setMyGroups] = useState<GroupWithRole[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  // No loading spinners: start in empty state, update silently when data arrives
  useEffect(() => {
    let cancelled = false;
    groupsApi
      .listMine()
      .then((data) => {
        if (!cancelled) setMyGroups(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tab !== 'explore' || allGroups.length > 0) return;
    let cancelled = false;
    groupsApi
      .list()
      .then((data) => {
        if (!cancelled) setAllGroups(data.groups);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab, allGroups.length]);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold text-text">{t('grupos.titulo')}</h1>
        </div>

        <div className="flex gap-1 border-b border-border">
          {TABS.map(({ id, key }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-4 pb-2.5 text-sm font-medium transition-colors ${
                tab === id
                  ? 'border-b-2 border-(--didacta-trust) text-(--didacta-trust)'
                  : 'text-text-muted hover:text-text'
              }`}
            >
              {t(`grupos.${key}`)}
              {id === 'mine' && (
                <span className="ml-1.5 rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
                  {myGroups.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'mine' ? (
          myGroups.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-12 text-center">
              <p className="text-base font-semibold text-text">{t('grupos.vacioMisTitulo')}</p>
              <p className="mt-1 text-sm text-text-muted">{t('grupos.vacioMisNota')}</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {myGroups.map((g) => (
                <GroupCard key={g.id} group={g} myRole={g.myRole} />
              ))}
            </div>
          )
        ) : allGroups.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-12 text-center">
            <p className="text-base font-semibold text-text">{t('grupos.vacioTodosTitulo')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('grupos.vacioTodosNota')}</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {allGroups.map((g) => (
              <GroupCard key={g.id} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
