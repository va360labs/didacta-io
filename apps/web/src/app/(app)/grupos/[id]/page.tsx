'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { groupsApi, type GroupDetail } from '@/lib/groups';

function initials(userId: string): string {
  return userId.slice(0, 2).toUpperCase();
}

export default function GroupDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    groupsApi
      .getOne(id)
      .then((data) => {
        if (!cancelled) setGroup(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleJoin() {
    if (!group) return;
    setJoining(true);
    try {
      await groupsApi.join(group.id);
      setJoined(true);
      setGroup((g) => (g ? { ...g, memberCount: g.memberCount + 1 } : g));
    } finally {
      setJoining(false);
    }
  }

  if (!group) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-base font-semibold text-text">Grupo no encontrado</p>
        <p className="text-sm text-text-muted">Este grupo no existe o aún no está disponible.</p>
        <Link
          href="/grupos"
          className="mt-2 rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Volver a grupos
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/grupos" className="text-xs text-text-muted hover:text-text">
            ← Grupos
          </Link>
          <h1 className="mt-1 font-display text-2xl font-bold text-text">{group.name}</h1>
          {group.description && <p className="mt-1 text-sm text-text-muted">{group.description}</p>}
          <p className="mt-2 text-xs text-text-muted">
            {group.memberCount} miembro{group.memberCount !== 1 ? 's' : ''}
          </p>
        </div>
        {!joined && (
          <button
            type="button"
            disabled={joining}
            onClick={handleJoin}
            className="shrink-0 rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {joining ? '…' : 'Unirme'}
          </button>
        )}
        {joined && (
          <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-3 py-1.5 text-sm font-semibold text-(--didacta-growth)">
            Miembro
          </span>
        )}
      </div>

      {group.members.length > 0 && (
        <div>
          <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Miembros
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3"
              >
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-(--didacta-trust)/10 text-[11px] font-bold text-(--didacta-trust)">
                  {initials(m.userId)}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-text">{m.userId.slice(0, 8)}…</p>
                  <p className="text-[10px] text-text-muted capitalize">{m.role}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
