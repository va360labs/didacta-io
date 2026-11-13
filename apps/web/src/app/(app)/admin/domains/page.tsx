'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Dominios propios (cuarto piloto License SDK).
 *
 * Reglas:
 *   - El panel completo va envuelto en `<EeGate>` con
 *     `LICENSE_CAPABILITIES.CUSTOM_DOMAINS`. Sin licencia EE se muestra el
 *     upsell card (mismo patrón que `MfaEnforcementUpsellCard` y
 *     `WhiteLabelUpsellCard`).
 *   - El backend GATEA además todos los endpoints (CRUD completo) — esto es
 *     solo UX. Cualquier intento de listar/crear sin la capability vuelve
 *     con 402 vía LicenseExceptionFilter.
 *   - Cuando la capability está activa pero la lista es la primera carga, los
 *     errores 402/403/auth se muestran sin romper la página.
 *
 * Flujo end-to-end del admin:
 *   1. Añade dominio → backend genera cnameTarget + verificationToken.
 *   2. Admin configura DNS (CNAME + TXT) en su proveedor.
 *   3. Admin pulsa "Validar" → POST /verify con el token. En piloto la
 *      verificación es manual (token compartido); en producción real un cron
 *      hace DNS-01 challenge automático.
 *   4. El dominio queda verified y puede activarse/desactivarse o borrarse.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { customDomainsApi, type CustomDomain, type CustomDomainStatus } from '@/lib/custom-domains';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';

export default function AdminDominiosPage() {
  const t = useTranslations('adminMarca');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('dominios.title')}</h1>
        <p className="text-text-muted">
          {t.rich('dominios.description', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      </header>

      <EeGate
        capability={LICENSE_CAPABILITIES.CUSTOM_DOMAINS}
        fallback={<CustomDomainsUpsellCard />}
      >
        <CustomDomainsPanel />
      </EeGate>
    </div>
  );
}

/**
 * Panel principal — solo se renderiza cuando la capability está activa.
 * Listado + form de alta + acciones por dominio.
 */
function CustomDomainsPanel() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [domains, setDomains] = useState<CustomDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostname, setHostname] = useState('');
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await customDomainsApi.list(token);
        setDomains(fresh.domains);
      } catch (e) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dominios.loadError'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const fresh = await customDomainsApi.list(token);
      setDomains(fresh.domains);
    } catch {
      // El último error ya se muestra al usuario; un fallo silencioso aquí
      // mantiene el estado anterior intacto.
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    const trimmed = hostname.trim().toLowerCase();
    if (!trimmed) return;
    setAdding(true);
    setActionError(null);
    try {
      const created = await customDomainsApi.add(token, trimmed);
      setDomains((prev) => (prev ? [...prev, created] : [created]));
      setHostname('');
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dominios.addError'),
      );
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify(domain: CustomDomain) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setActionError(null);
    try {
      // En el piloto, el frontend conoce el verificationToken (lo recibió al
      // crear el dominio) y lo reenvía aquí. En producción real el cron de
      // DNS-01 hace este check sin participación del cliente.
      await customDomainsApi.verify(token, domain.id, domain.verificationToken);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dominios.verifyError'),
      );
    }
  }

  async function handleToggle(domain: CustomDomain) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setActionError(null);
    const next = domain.status === 'inactive' ? 'verified' : 'inactive';
    try {
      await customDomainsApi.setStatus(token, domain.id, next);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dominios.statusError'),
      );
    }
  }

  async function handleDelete(domain: CustomDomain) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('dominios.deleteConfirm', { hostname: domain.hostname }))) return;
    setActionError(null);
    try {
      await customDomainsApi.remove(token, domain.id);
      setDomains((prev) => (prev ? prev.filter((d) => d.id !== domain.id) : prev));
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('dominios.deleteError'),
      );
    }
  }

  if (domains === null && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  const list = domains ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Form alta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="plus" size={18} />
            {t('dominios.addTitle')}
          </CardTitle>
          <CardDescription>
            {t.rich('dominios.addDescription', {
              code: (chunks) => <code>{chunks}</code>,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="hostname">{t('dominios.hostnameLabel')}</Label>
              <Input
                id="hostname"
                placeholder={t('dominios.hostnamePlaceholder')}
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={adding}
              />
            </div>
            <Button type="submit" disabled={adding || hostname.trim().length === 0}>
              {adding ? t('dominios.adding') : t('dominios.addButton')}
            </Button>
          </form>
          {actionError ? <p className="mt-3 text-sm text-danger-700">{actionError}</p> : null}
        </CardContent>
      </Card>

      {/* Lista */}
      {list.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">{t('dominios.empty')}</CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((d) => (
            <DomainRow
              key={d.id}
              domain={d}
              onVerify={() => handleVerify(d)}
              onToggle={() => handleToggle(d)}
              onDelete={() => handleDelete(d)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DomainRow({
  domain,
  onVerify,
  onToggle,
  onDelete,
}: {
  domain: CustomDomain;
  onVerify: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('adminMarca');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 break-all">
          <Icon name="building" size={18} />
          <span className="font-mono">{domain.hostname}</span>
          <DomainStatusBadge status={domain.status} />
        </CardTitle>
        <CardDescription>
          {t('dominios.addedAt', { date: formatDateTime(domain.createdAt) })}
          {/* El separador ` · ` es maquetación, no copy: vive aquí y no dentro del
              valor del catálogo (un traductor que recorta el valor rompía la frase). */}
          {domain.verifiedAt
            ? ` · ${t('dominios.verifiedAtSuffix', { date: formatDateTime(domain.verifiedAt) })}`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {domain.status === 'pending' ? (
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm text-warning-800">
            <p className="font-semibold">{t('dominios.dnsTitle')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                {t.rich('dominios.dnsCname', {
                  hostname: domain.hostname,
                  target: domain.cnameTarget,
                  mono: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </li>
              <li>
                {t.rich('dominios.dnsTxt', {
                  hostname: domain.hostname,
                  token: domain.verificationToken,
                  mono: (chunks) => <code className="font-mono">{chunks}</code>,
                  tokenCode: (chunks) => (
                    <code className="ml-2 break-all rounded bg-surface-2 px-2 py-0.5 font-mono text-xs">
                      {chunks}
                    </code>
                  ),
                })}
              </li>
            </ul>
            <p className="mt-2 text-xs text-warning-700">{t('dominios.dnsNote')}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {domain.status === 'pending' ? (
            <Button type="button" onClick={onVerify}>
              {t('dominios.verifyButton')}
            </Button>
          ) : null}
          {domain.status !== 'pending' ? (
            <Button type="button" variant="secondary" onClick={onToggle}>
              {domain.status === 'inactive' ? t('dominios.reactivate') : t('dominios.deactivate')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onDelete}>
            <Icon name="trash" size={16} />
            {t('dominios.deleteButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DomainStatusBadge({ status }: { status: CustomDomainStatus }) {
  const t = useTranslations('adminMarca');
  if (status === 'verified') {
    return <Badge className="bg-success-600 text-white">{t('dominios.statusVerified')}</Badge>;
  }
  if (status === 'inactive') {
    return <Badge variant="outline">{t('dominios.statusInactive')}</Badge>;
  }
  return (
    <Badge variant="outline" className="border-warning-200 bg-warning-50 text-warning-700">
      {t('dominios.statusPending')}
    </Badge>
  );
}

/**
 * Tarjeta de upsell para plan community (sin licencia EE). Sigue el patrón
 * de `MfaEnforcementUpsellCard` y `WhiteLabelUpsellCard`. Recordatorio: el
 * backend gatea con @RequiresCapability — esto solo es UX.
 */
export function CustomDomainsUpsellCard() {
  const t = useTranslations('adminMarca');
  return (
    <Card role="region" aria-label={t('dominios.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('dominios.upsellTitle')}
        </CardTitle>
        <CardDescription>
          {t.rich('dominios.upsellDescription', {
            slugHost: '<slug>.didacta.io',
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('dominios.upsellBody', {
            code: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
          })}
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('dominios.upsellCta')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}
