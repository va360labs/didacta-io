'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Admin · Identidad (SSO) — un solo destino para los tres protocolos.
 *
 * Eran tres páginas casi idénticas (`/admin/sso`, `/admin/sso-saml`,
 * `/admin/sso-wordpress`) que ocupaban 4 de los 6 huecos del grupo "Seguridad" y
 * empujaban hacia abajo la política MFA, que es lo único que se toca de forma
 * habitual. Las dos rutas antiguas redirigen a su pestaña.
 *
 * El gating no cambia: cada pestaña conserva su propio `<EeGate>` (OIDC y SAML
 * son EE, WordPress es Community) y el backend sigue gateando cada endpoint con
 * @RequiresCapability — esto es solo UX.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { OidcTab } from '@/components/admin/sso/oidc-tab';
import { SamlTab } from '@/components/admin/sso/saml-tab';
import { WordpressTab } from '@/components/admin/sso/wordpress-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TABS = ['oidc', 'saml', 'wordpress'] as const;
type TabKey = (typeof TABS)[number];

export default function AdminSsoPage() {
  const t = useTranslations('adminSso');
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'oidc';

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('sso.pageTitle')}</h1>
        <p className="text-text-muted">{t('sso.pageSubtitle')}</p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          router.replace(next === 'oidc' ? '/admin/sso' : `/admin/sso?tab=${next}`)
        }
      >
        <TabsList>
          <TabsTrigger value="oidc">{t('sso.tabOidc')}</TabsTrigger>
          <TabsTrigger value="saml">{t('sso.tabSaml')}</TabsTrigger>
          <TabsTrigger value="wordpress">{t('sso.tabWordpress')}</TabsTrigger>
        </TabsList>

        <TabsContent value="oidc" className="mt-5">
          <OidcTab />
        </TabsContent>
        <TabsContent value="saml" className="mt-5">
          <SamlTab />
        </TabsContent>
        <TabsContent value="wordpress" className="mt-5">
          <WordpressTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
