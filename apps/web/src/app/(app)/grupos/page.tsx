'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { groupsApi, type Group, type GroupWithRole } from '@/lib/groups';

type Tab = 'Mis grupos' | 'Explorar';

function GroupCard({ group, myRole }: { group: Group; myRole?: string }) {
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
            {myRole === 'owner' ? 'Admin' : 'Miembro'}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {group.memberCount} miembro{group.memberCount !== 1 ? 's' : ''}
      </p>
    </Link>
  );
}

export default function GruposPage() {
  const [tab, setTab] = useState<Tab>('Mis grupos');
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
    if (tab !== 'Explorar' || allGroups.length > 0) return;
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
          <h1 className="font-display text-2xl font-bold text-text">Grupos</h1>
        </div>

        <div className="flex gap-1 border-b border-border">
          {(['Mis grupos', 'Explorar'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 pb-2.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'border-b-2 border-(--didacta-trust) text-(--didacta-trust)'
                  : 'text-text-muted hover:text-text'
              }`}
            >
              {t}
              {t === 'Mis grupos' && (
                <span className="ml-1.5 rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
                  {myGroups.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'Mis grupos' ? (
          myGroups.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-12 text-center">
              <p className="text-base font-semibold text-text">Aún no perteneces a ningún grupo</p>
              <p className="mt-1 text-sm text-text-muted">
                Cuando te unas a un grupo, aparecerá aquí.
              </p>
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
            <p className="text-base font-semibold text-text">No hay grupos disponibles</p>
            <p className="mt-1 text-sm text-text-muted">
              Los grupos estarán disponibles próximamente.
            </p>
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
