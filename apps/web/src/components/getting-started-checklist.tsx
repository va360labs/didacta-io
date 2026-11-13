'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta «Primeros pasos» del panel (lote de feedback de onboarding).
 *
 * Vive encima del feed de comunidad — el aterrizaje real de `/home` — y
 * solo para admins con el asistente de bienvenida COMPLETADO: mientras no lo
 * esté, el gate del shell ya manda a `/welcome` y esta tarjeta sobraría.
 *
 * Cada ítem se deriva de datos reales (ver `lib/getting-started.ts`) y las
 * fuentes se leen en paralelo y best-effort: una API caída omite su ítem, no
 * rompe la tarjeta ni el feed. Descartable en cualquier momento (localStorage
 * por tenant): quien no vaya a usar Stripe no tiene por qué ver «Conecta los
 * cobros» para siempre. Patrón visual: el `PublishChecklist` del editor de
 * cursos.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { academyApi, onboardingApi } from '@/lib/academy';
import { adminSmtpApi, deriveSmtpStatus } from '@/lib/admin-smtp';
import { adminStripeApi } from '@/lib/admin-stripe';
import { authStorage } from '@/lib/auth-storage';
import {
  checklistDismissed,
  deriveChecklist,
  dismissChecklist,
  isChecklistComplete,
  type ChecklistItem,
} from '@/lib/getting-started';
import { payoutsApi } from '@/lib/payouts';
import { themingApi } from '@/lib/theming';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'];

export function GettingStartedChecklist(): React.JSX.Element | null {
  const t = useTranslations('shell');
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const session = authStorage.getSession();
    const token = authStorage.getAccessToken();
    if (!session || !token) return;
    if (!session.user.roles.some((r) => ADMIN_ROLES.includes(r))) return;
    const tid = session.user.tenantId;
    if (checklistDismissed(tid)) return;

    let cancelled = false;
    void (async () => {
      // El progreso decide si la tarjeta aplica; el resto de fuentes solo
      // aportan ítems. Todas best-effort.
      const [progress, academy, theme, smtp, stripe, payouts] = await Promise.all([
        onboardingApi.read().catch(() => null),
        academyApi.getMine(token).catch(() => null),
        themingApi.getMine(token).catch(() => null),
        adminSmtpApi.get().catch(() => null),
        adminStripeApi.get().catch(() => null),
        // Cobros de plataforma (Cloud): conectar cobros en vez de pegar claves.
        payoutsApi.status().catch(() => null),
      ]);
      if (cancelled) return;
      // Sin progreso legible o con el asistente a medias, no hay tarjeta.
      if (!progress?.completedAt) return;
      setTenantId(tid);
      setItems(
        deriveChecklist({
          academy,
          theme,
          smtpStatus: smtp ? deriveSmtpStatus(smtp) : null,
          stripeConfigured: stripe ? stripe.hasSecretKey : null,
          progress,
          platformPayoutsReady: payouts?.mode === 'platform' ? payouts.ready : null,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden || !items || items.length === 0 || !tenantId) return null;

  const completo = isChecklistComplete(items);
  const hechos = items.filter((i) => i.done).length;

  function ocultar(): void {
    dismissChecklist(tenantId!);
    setHidden(true);
  }

  return (
    <Card className={completo ? 'border-success-200 bg-success-50/40' : undefined}>
      <CardContent className="space-y-3 p-5" data-testid="getting-started-checklist">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className={
                completo
                  ? 'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-success-100 text-success-700'
                  : 'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700'
              }
            >
              <Icon name={completo ? 'sparkles' : 'check'} size={18} />
            </span>
            <div>
              <p className="font-display text-sm font-bold">
                {completo ? t('gettingStarted.doneTitle') : t('gettingStarted.title')}
              </p>
              <p className="text-xs text-text-muted">
                {completo
                  ? t('gettingStarted.doneBody')
                  : t('gettingStarted.subtitle', { done: hechos, total: items.length })}
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={ocultar}>
            {t('gettingStarted.dismiss')}
          </Button>
        </div>

        {!completo ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.key}>
                {item.done ? (
                  <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-subtle">
                    <Icon name="check" size={16} className="shrink-0 text-success-600" />
                    <span className="line-through">
                      {t(`gettingStarted.item.${item.key}` as never)}
                    </span>
                  </span>
                ) : (
                  <Link
                    href={item.href}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-brand-50 hover:text-brand-700"
                  >
                    <Icon name="circle" size={16} className="shrink-0 text-text-subtle" />
                    {t(`gettingStarted.item.${item.key}` as never)}
                    <Icon name="arrow-right" size={14} className="ml-auto shrink-0 opacity-60" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
