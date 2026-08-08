'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { adminUsersApi, ASSIGNABLE_ROLES, type AssignableRole } from '@/lib/admin-users';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { authStorage } from '@/lib/auth-storage';

export default function InvitarPage() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('alumno');
  const [groupId, setGroupId] = useState('');
  // null = catálogo no disponible (módulo desactivado) → el campo no se pinta.
  const [groups, setGroups] = useState<AccessGroupListItem[] | null>(null);

  useEffect(() => {
    let aborted = false;
    const token = authStorage.getAccessToken();
    if (!token) return;
    accessGroupsApi
      .list(token)
      .then((r) => {
        if (!aborted && r.groups.length > 0) setGroups(r.groups);
      })
      .catch(() => undefined);
    return () => {
      aborted = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const token = authStorage.getAccessToken();
    if (!token) {
      setError(t('invite.sessionExpired'));
      setPending(false);
      return;
    }
    try {
      await adminUsersApi.invite(token, {
        email: email.trim(),
        name: name.trim() || undefined,
        role,
        accessGroupId: groupId || undefined,
      });
      router.push('/admin/usuarios');
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/admin/usuarios">{t('invite.back')}</Link>
      </Button>

      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('invite.title')}</h1>
        <p className="mt-1 text-text-muted">{t('invite.subtitle')}</p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="user" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle>{t('invite.cardTitle')}</CardTitle>
              <CardDescription>{t('invite.cardDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">
                {t('invite.emailLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder={t('invite.emailPlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">{t('invite.nameLabel')}</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('invite.namePlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">
                {t('invite.roleLabel')} <span className="text-danger-700">*</span>
              </Label>
              <Select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value as AssignableRole)}
              >
                {ASSIGNABLE_ROLES.map((k) => (
                  <option key={k} value={k}>
                    {t(`roles.${k}`)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">{t(`roleDesc.${role}`)}</p>
            </div>

            {groups ? (
              <div className="space-y-2">
                <Label htmlFor="accessGroup">{t('invite.groupLabel')}</Label>
                <Select
                  id="accessGroup"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  data-testid="invite-group-select"
                >
                  <option value="">{t('invite.noGroup')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-text-subtle">{t('invite.groupHint')}</p>
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3 border-t border-border-soft pt-4">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                {t('invite.cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('invite.submitting') : t('invite.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
