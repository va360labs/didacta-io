'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Tab "Aula virtual" de /admin/configuracion: formulario de credenciales Zoom
/// Server-to-Server del módulo mod.zoom-live.
///
/// mod.zoom-live es un módulo BUILT-IN (no se instala por ZIP del marketplace),
/// así que su UI vive aquí, en apps/web, compilada en el host — NO en un surface
/// bundle cargado por `loadModuleUI` (ese mecanismo solo sirve módulos instalados
/// por ZIP; para un built-in devuelve 404 "no está instalado"). Patrón correcto,
/// igual que el resto de módulos core in-tree (community, payment-connections…).

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { zoomLiveApi } from './client';

type TestStatus =
  | 'idle'
  | 'testing'
  | { kind: 'real' | 'stub'; accountId: string }
  | { error: string };

export function ZoomAdminSurface() {
  const [draft, setDraft] = useState({
    accountId: '',
    clientId: '',
    clientSecret: '',
    webhookSecret: '',
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('saving');
    setErrMsg(null);
    try {
      await zoomLiveApi.upsertCredentials({
        accountId: draft.accountId.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        // Siempre se manda (aunque vacío): el merge del backend conserva el
        // guardado previo cuando llega vacío, igual que clientSecret. Si se
        // omitiera la clave por completo del body, el merge no tendría nada
        // que preservar.
        webhookSecret: draft.webhookSecret,
      });
      setStatus('saved');
      setDraft((s) => ({ ...s, clientSecret: '', webhookSecret: '' }));
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof ApiHttpError ? e.message : 'No pudimos guardar las credenciales.');
    }
  }

  async function handleClear() {
    if (!confirm('¿Borrar las credenciales Zoom S2S? Las sesiones nuevas caerán al stub.')) return;
    setStatus('saving');
    setErrMsg(null);
    try {
      await zoomLiveApi.removeCredentials();
      setStatus('saved');
      setDraft({ accountId: '', clientId: '', clientSecret: '', webhookSecret: '' });
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof ApiHttpError ? e.message : 'No pudimos borrar las credenciales.');
    }
  }

  async function handleTest() {
    setTestStatus('testing');
    try {
      const res = await zoomLiveApi.testCredentials();
      setTestStatus(res);
    } catch (e) {
      setTestStatus({
        error: e instanceof ApiHttpError ? e.message : 'No pudimos validar las credenciales.',
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aula virtual · Zoom Server-to-Server</CardTitle>
        <CardDescription>
          Pega las credenciales Server-to-Server OAuth de tu cuenta Zoom. Se guardan cifradas
          (AES-256-GCM) y nunca se devuelven en claro. Si las dejas vacías, el módulo cae al stub de
          desarrollo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="zoom-account">Account ID</Label>
            <Input
              id="zoom-account"
              required
              value={draft.accountId}
              onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-client">Client ID</Label>
            <Input
              id="zoom-client"
              required
              value={draft.clientId}
              onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zoom-secret">Client Secret</Label>
            <Input
              id="zoom-secret"
              required
              type="password"
              value={draft.clientSecret}
              onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="zoom-webhook-secret">Webhook Secret Token</Label>
            <Input
              id="zoom-webhook-secret"
              type="password"
              value={draft.webhookSecret}
              onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })}
              autoComplete="new-password"
              placeholder="(dejar vacío para conservar el actual)"
            />
            <p className="text-xs text-text-subtle">
              El &quot;Secret Token&quot; que Zoom te da al configurar el webhook de tu app,
              apuntando a <code className="font-mono">https://tu-dominio/api/v1/webhooks/zoom</code>
              . Sin esto, el aula virtual no recibe eventos de inicio/fin de reunión.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? 'Guardando…' : 'Guardar credenciales'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleTest}
              disabled={testStatus === 'testing'}
            >
              {testStatus === 'testing' ? 'Probando…' : 'Probar credenciales'}
            </Button>
            <Button type="button" variant="ghost" onClick={handleClear}>
              Borrar credenciales
            </Button>
            {status === 'saved' ? (
              <span className="text-sm text-success-700">✓ Guardado cifrado.</span>
            ) : null}
            {status === 'error' && errMsg ? (
              <span className="text-sm text-danger-700">{errMsg}</span>
            ) : null}
          </div>
          {typeof testStatus === 'object' && 'kind' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
              {testStatus.kind === 'real'
                ? `✓ Credenciales válidas. Vinculado a la cuenta Zoom ${testStatus.accountId}.`
                : '⚠ El módulo está usando el stub local — no hay credenciales reales configuradas todavía.'}
            </div>
          ) : null}
          {typeof testStatus === 'object' && 'error' in testStatus ? (
            <div className="sm:col-span-2 rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
              ✗ {testStatus.error}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
