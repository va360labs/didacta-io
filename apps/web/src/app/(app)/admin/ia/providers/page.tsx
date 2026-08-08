'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  aiProvidersApi,
  aiTutorApi,
  type ProviderCatalogEntry,
  type ReindexAllResultView,
  type TenantProviderConfig,
} from '@/modules/ai-tutor';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';

type Purpose = 'chat' | 'embed';

interface FormDraft {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  notas: string;
}

const EMPTY_DRAFT: FormDraft = {
  provider: '',
  model: '',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  notas: '',
};

/**
 * Nombres de los proveedores soportados. Son MARCAS (OpenAI, Anthropic,
 * Gemini…): no se traducen, por eso no viven en el catálogo i18n.
 */
const PROVIDER_NAME: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  mistral: 'Mistral AI',
  groq: 'Groq',
  ollama: 'Ollama (self-hosted)',
  voyage: 'Voyage AI',
};

/**
 * Panel admin para gestionar configs IA del tenant (LMS-90.E).
 *
 * Permite elegir, por purpose (chat / embed), qué proveedor usar y con qué
 * API key. La key viaja en el body del PUT y se cifra (AES-256-GCM) antes
 * de persistirse: nunca se devuelve en plaintext, así que para "ver" o
 * cambiarla hay que reintroducirla.
 *
 * Si el tenant no tiene config para un purpose, el AI Gateway cae al
 * default global del cluster (env vars OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * etc.). Si tampoco hay default → error 424 al usar el tutor.
 */
export default function AiProvidersAdminPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
  const [configs, setConfigs] = useState<TenantProviderConfig[] | null>(null);
  const [drafts, setDrafts] = useState<Record<Purpose, FormDraft>>({
    chat: { ...EMPTY_DRAFT },
    embed: { ...EMPTY_DRAFT },
  });
  const [pending, setPending] = useState<Purpose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<ReindexAllResultView | null>(null);

  async function reload() {
    try {
      const [cat, list] = await Promise.all([aiProvidersApi.catalog(), aiProvidersApi.list()]);
      setCatalog(cat);
      setConfigs(list);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const providersByCapability = useMemo(() => {
    if (!catalog) return { chat: [], embed: [] } as Record<Purpose, ProviderCatalogEntry[]>;
    return {
      chat: catalog.filter((c) => c.capabilities.includes('chat')),
      embed: catalog.filter((c) => c.capabilities.includes('embed')),
    };
  }, [catalog]);

  function getCurrent(purpose: Purpose): TenantProviderConfig | null {
    return configs?.find((c) => c.purpose === purpose) ?? null;
  }

  function updateDraft(purpose: Purpose, patch: Partial<FormDraft>) {
    setDrafts((d) => ({ ...d, [purpose]: { ...d[purpose], ...patch } }));
  }

  async function handleSave(purpose: Purpose, e: FormEvent) {
    e.preventDefault();
    const d = drafts[purpose];
    if (!d.provider || !d.apiKey) {
      setError(t('aiProviders.missingFields'));
      return;
    }
    setPending(purpose);
    setError(null);
    setInfo(null);
    try {
      await aiProvidersApi.upsert(purpose, {
        provider: d.provider,
        model: d.model.trim() || undefined,
        apiKey: d.apiKey,
        baseUrl: d.baseUrl.trim() || undefined,
        enabled: d.enabled,
        notas: d.notas.trim() || undefined,
      });
      setInfo(t('aiProviders.savedInfo', { purpose: t(`purposeLabels.${purpose}`) }));
      updateDraft(purpose, { apiKey: '' }); // limpiar key del form post-save
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(null);
    }
  }

  async function handleRemove(purpose: Purpose) {
    if (
      !window.confirm(t('aiProviders.deleteConfirm', { purpose: t(`purposeLabels.${purpose}`) }))
    ) {
      return;
    }
    setPending(purpose);
    setError(null);
    setInfo(null);
    try {
      await aiProvidersApi.remove(purpose);
      setInfo(t('aiProviders.removedInfo', { purpose: t(`purposeLabels.${purpose}`) }));
      await reload();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setPending(null);
    }
  }

  async function handleReindexAll() {
    setReindexing(true);
    setError(null);
    setInfo(null);
    setReindexResult(null);
    try {
      const res = await aiTutorApi.reindexAll();
      setReindexResult(res);
      setInfo(
        res.failed
          ? t('aiProviders.reindexDoneWithFailed', {
              indexed: res.indexed,
              total: res.total,
              failed: res.failed,
            })
          : t('aiProviders.reindexDoneOk', { indexed: res.indexed, total: res.total }),
      );
    } catch (e) {
      // Reindexar el catálogo entero tarda minutos y el proxy corta la conexión
      // antes de que termine. Cuando eso pasa NO ha fallado nada: el servidor
      // sigue trabajando. Decir «no pudimos reindexar» mandó a buscar un fallo
      // en la configuración cuando el índice se había regenerado entero
      // (2026-07-30). Sólo un error con respuesta del servidor es un error real.
      setError(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : t('aiProviders.reindexConnectionCut'),
      );
    } finally {
      setReindexing(false);
    }
  }

  if (catalog === null || configs === null) {
    return (
      <section className="space-y-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('aiProviders.title')}</h1>
        <p className="mt-1 text-text-muted">{t('aiProviders.subtitle')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
          {info}
        </div>
      ) : null}

      {(['chat', 'embed'] as Purpose[]).map((purpose) => {
        const current = getCurrent(purpose);
        const draft = drafts[purpose];
        const opts = providersByCapability[purpose];
        return (
          <Card key={purpose}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t(`purposeLabels.${purpose}`)}
                {current ? (
                  <Badge variant={current.enabled ? 'success' : 'muted'}>
                    {current.enabled
                      ? t('aiProviders.activeBadge')
                      : t('aiProviders.disabledBadge')}
                  </Badge>
                ) : (
                  <Badge variant="muted">{t('aiProviders.noConfigBadge')}</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {current
                  ? current.model
                    ? t('aiProviders.currentProviderModel', {
                        name: PROVIDER_NAME[current.provider] ?? current.provider,
                        model: current.model,
                      })
                    : t('aiProviders.currentProvider', {
                        name: PROVIDER_NAME[current.provider] ?? current.provider,
                      })
                  : t('aiProviders.noConfigDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => void handleSave(purpose, e)}
                className="grid gap-4 sm:grid-cols-2"
              >
                <div className="space-y-1">
                  <Label htmlFor={`${purpose}-provider`}>{t('aiProviders.providerLabel')}</Label>
                  <Select
                    id={`${purpose}-provider`}
                    value={draft.provider}
                    onChange={(e) => updateDraft(purpose, { provider: e.target.value })}
                  >
                    <option value="">{t('aiProviders.providerPlaceholder')}</option>
                    {opts.map((o) => (
                      <option key={o.id} value={o.id}>
                        {PROVIDER_NAME[o.id] ?? o.id}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${purpose}-model`}>{t('aiProviders.modelLabel')}</Label>
                  <Input
                    id={`${purpose}-model`}
                    value={draft.model}
                    onChange={(e) => updateDraft(purpose, { model: e.target.value })}
                    placeholder={
                      purpose === 'chat'
                        ? t('aiProviders.modelPlaceholderChat')
                        : t('aiProviders.modelPlaceholderEmbed')
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-key`}>{t('aiProviders.apiKeyLabel')}</Label>
                  <Input
                    id={`${purpose}-key`}
                    type="password"
                    value={draft.apiKey}
                    onChange={(e) => updateDraft(purpose, { apiKey: e.target.value })}
                    placeholder={current?.hasApiKey ? t('aiProviders.apiKeyPlaceholder') : ''}
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-text-subtle">{t('aiProviders.apiKeyHint')}</p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-baseurl`}>{t('aiProviders.baseUrlLabel')}</Label>
                  <Input
                    id={`${purpose}-baseurl`}
                    value={draft.baseUrl}
                    onChange={(e) => updateDraft(purpose, { baseUrl: e.target.value })}
                    placeholder={t('aiProviders.baseUrlPlaceholder')}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-notas`}>{t('aiProviders.notesLabel')}</Label>
                  <Input
                    id={`${purpose}-notas`}
                    value={draft.notas}
                    onChange={(e) => updateDraft(purpose, { notas: e.target.value })}
                    placeholder={t('aiProviders.notesPlaceholder')}
                  />
                </div>
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(v: boolean) => updateDraft(purpose, { enabled: v })}
                    id={`${purpose}-enabled`}
                  />
                  <Label htmlFor={`${purpose}-enabled`} className="cursor-pointer">
                    {t('aiProviders.enabled')}
                  </Label>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button type="submit" disabled={pending === purpose}>
                    {pending === purpose
                      ? t('aiProviders.saving')
                      : current
                        ? t('aiProviders.update')
                        : t('aiProviders.save')}
                  </Button>
                  {current ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void handleRemove(purpose)}
                      disabled={pending === purpose}
                    >
                      {t('aiProviders.removeConfig')}
                    </Button>
                  ) : null}
                </div>
              </form>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>{t('aiProviders.reindexTitle')}</CardTitle>
          <CardDescription>{t('aiProviders.reindexDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" onClick={() => void handleReindexAll()} disabled={reindexing}>
            {reindexing ? t('aiProviders.reindexing') : t('aiProviders.reindexRun')}
          </Button>
          {reindexResult ? (
            <p className="text-sm text-text-muted">
              {t('aiProviders.reindexStats', {
                indexed: reindexResult.indexed,
                failed: reindexResult.failed,
                total: reindexResult.total,
              })}
              {reindexResult.failed > 0 ? (
                <span className="text-danger-700"> {t('aiProviders.reindexCheckQuota')}</span>
              ) : null}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
