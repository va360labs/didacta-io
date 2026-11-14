'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Señales de confianza junto al pago: quién cobra y cómo, quién vende, qué
 * pasa con el desistimiento o la renovación, y a quién escribir. Todo sale de
 * datos reales del aula (`GET /public/checkout-seller`); lo que el aula no ha
 * configurado (el correo de contacto) simplemente no aparece.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { getCheckoutSeller, type CheckoutSeller } from '@/lib/checkout';

/** Quién vende, pedido una vez por pestaña. */
let sellerPromise: Promise<CheckoutSeller | null> | null = null;

export function useCheckoutSeller(): CheckoutSeller | null {
  const [seller, setSeller] = useState<CheckoutSeller | null>(null);
  useEffect(() => {
    let alive = true;
    sellerPromise ??= getCheckoutSeller();
    void sellerPromise.then((s) => {
      if (alive) setSeller(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return seller;
}

interface Props {
  /** Lo que se compra: cambia la línea de la política. */
  kind: 'course' | 'membership';
  seller: CheckoutSeller | null;
  /** Nombre del aula mientras llega `seller` (viene del contexto del aula). */
  fallbackName?: string | null;
  /** `compact`: debajo del botón de compra de la ficha. */
  variant?: 'full' | 'compact';
}

export function CheckoutTrust({ kind, seller, fallbackName, variant = 'full' }: Props) {
  const t = useTranslations('publicSite.pago.trust');
  const name = seller?.name ?? fallbackName ?? null;
  const items: Array<{ icon: 'lock' | 'shield' | 'check' | 'mail'; title: string; body: string }> =
    [];
  items.push({
    icon: 'lock',
    title: t('secureTitle'),
    body: name ? t('secureBody', { name }) : t('secureBodyNoName'),
  });
  if (name) {
    items.push({
      icon: 'shield',
      title: t('sellerTitle', { name }),
      body: seller?.creator
        ? t(kind === 'course' ? 'sellerCreatorCourse' : 'sellerCreatorMembership', {
            creator: seller.creator.name,
          })
        : t('sellerBody'),
    });
  }
  items.push({
    icon: 'check',
    title: t(kind === 'course' ? 'policyCourseTitle' : 'policyMembershipTitle'),
    body: t(kind === 'course' ? 'policyCourseBody' : 'policyMembershipBody'),
  });
  if (seller?.contactEmail) {
    items.push({
      icon: 'mail',
      title: t('contactTitle'),
      body: seller.contactEmail,
    });
  }

  if (variant === 'compact') {
    return (
      <ul className="space-y-2 text-[13px] leading-5 text-text-muted" data-testid="confianza-pago">
        {items.map((item) => (
          <li key={item.icon} className="flex items-start gap-2">
            <Icon name={item.icon} size={14} className="mt-0.5 shrink-0 text-brand-700" />
            <span>
              <strong className="font-semibold text-text">{item.title}</strong>
              {item.icon === 'mail' ? (
                <>
                  {' '}
                  <a href={`mailto:${item.body}`} className="text-brand-700 hover:underline">
                    {item.body}
                  </a>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="divide-y divide-border-soft" data-testid="confianza-pago">
      {items.map((item) => (
        <li key={item.icon} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
            <Icon name={item.icon} size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold text-text">{item.title}</span>
            {item.icon === 'mail' ? (
              <a
                href={`mailto:${item.body}`}
                className="block break-all text-sm text-brand-700 hover:underline"
              >
                {item.body}
              </a>
            ) : (
              <span className="block text-sm leading-5 text-text-muted">{item.body}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
