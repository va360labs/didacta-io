'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
  type ProviderCatalogEntry,
  type TenantProviderConfig,
} from '@/modules/ai-tutor';
import { ApiHttpError } from '@/lib/api-client';

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

const PURPOSE_LABEL: Record<Purpose, string> = {
  chat: 'Chat (tutor IA)',
  embed: 'Embeddings (indexación de cursos)',
};

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
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
  const [configs, setConfigs] = useState<TenantProviderConfig[] | null>(null);
  const [drafts, setDrafts] = useState<Record<Purpose, FormDraft>>({
    chat: { ...EMPTY_DRAFT },
    embed: { ...EMPTY_DRAFT },
  });
  const [pending, setPending] = useState<Purpose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function reload() {
    try {
      const [cat, list] = await Promise.all([aiProvidersApi.catalog(), aiProvidersApi.list()]);
      setCatalog(cat);
      setConfigs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las configs IA.');
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
      setError('Tienes que elegir un proveedor y una API key.');
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
      setInfo(`Config de ${PURPOSE_LABEL[purpose]} guardada.`);
      updateDraft(purpose, { apiKey: '' }); // limpiar key del form post-save
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la config.');
    } finally {
      setPending(null);
    }
  }

  async function handleRemove(purpose: Purpose) {
    if (
      !window.confirm(`¿Borrar la config de ${PURPOSE_LABEL[purpose]}? Caerá al default global.`)
    ) {
      return;
    }
    setPending(purpose);
    setError(null);
    setInfo(null);
    try {
      await aiProvidersApi.remove(purpose);
      setInfo(`Config de ${PURPOSE_LABEL[purpose]} eliminada.`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos borrar la config.');
    } finally {
      setPending(null);
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
        <h1 className="font-display text-2xl font-bold tracking-tight">Proveedores de IA</h1>
        <p className="mt-1 text-text-muted">
          Configura qué proveedor de IA usar para el tutor (chat) y para la indexación de cursos
          (embeddings). La API key se cifra antes de guardarse y nunca se vuelve a mostrar.
        </p>
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
                {PURPOSE_LABEL[purpose]}
                {current ? (
                  <Badge variant={current.enabled ? 'success' : 'muted'}>
                    {current.enabled ? 'Activo' : 'Desactivado'}
                  </Badge>
                ) : (
                  <Badge variant="muted">Sin config (default global)</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {current
                  ? `Proveedor actual: ${PROVIDER_NAME[current.provider] ?? current.provider}${current.model ? ` · modelo ${current.model}` : ''}.`
                  : 'No hay proveedor específico para este tenant. Se usará el default del cluster si está configurado.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => void handleSave(purpose, e)}
                className="grid gap-4 sm:grid-cols-2"
              >
                <div className="space-y-1">
                  <Label htmlFor={`${purpose}-provider`}>Proveedor</Label>
                  <Select
                    id={`${purpose}-provider`}
                    value={draft.provider}
                    onChange={(e) => updateDraft(purpose, { provider: e.target.value })}
                  >
                    <option value="">— Elige proveedor —</option>
                    {opts.map((o) => (
                      <option key={o.id} value={o.id}>
                        {PROVIDER_NAME[o.id] ?? o.id}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${purpose}-model`}>Modelo (opcional)</Label>
                  <Input
                    id={`${purpose}-model`}
                    value={draft.model}
                    onChange={(e) => updateDraft(purpose, { model: e.target.value })}
                    placeholder={
                      purpose === 'chat'
                        ? 'ej. gpt-4o-mini, claude-3-5-sonnet-20241022'
                        : 'ej. text-embedding-3-small, voyage-3'
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-key`}>API key</Label>
                  <Input
                    id={`${purpose}-key`}
                    type="password"
                    value={draft.apiKey}
                    onChange={(e) => updateDraft(purpose, { apiKey: e.target.value })}
                    placeholder={current?.hasApiKey ? '•••••••••• (reintroducir para cambiar)' : ''}
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-text-subtle">
                    Se cifra con AES-256-GCM antes de persistirse. Nunca se devuelve al cliente.
                  </p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-baseurl`}>Base URL (opcional)</Label>
                  <Input
                    id={`${purpose}-baseurl`}
                    value={draft.baseUrl}
                    onChange={(e) => updateDraft(purpose, { baseUrl: e.target.value })}
                    placeholder="ej. https://openrouter.ai/api/v1 o http://ollama.local:11434"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`${purpose}-notas`}>Notas internas</Label>
                  <Input
                    id={`${purpose}-notas`}
                    value={draft.notas}
                    onChange={(e) => updateDraft(purpose, { notas: e.target.value })}
                    placeholder="Para acordarse en qué cuenta facturadora vive esta key."
                  />
                </div>
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(v: boolean) => updateDraft(purpose, { enabled: v })}
                    id={`${purpose}-enabled`}
                  />
                  <Label htmlFor={`${purpose}-enabled`} className="cursor-pointer">
                    Habilitado
                  </Label>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button type="submit" disabled={pending === purpose}>
                    {pending === purpose ? 'Guardando…' : current ? 'Actualizar' : 'Guardar'}
                  </Button>
                  {current ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void handleRemove(purpose)}
                      disabled={pending === purpose}
                    >
                      Borrar config (caer a default)
                    </Button>
                  ) : null}
                </div>
              </form>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
