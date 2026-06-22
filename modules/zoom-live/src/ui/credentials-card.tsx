import type { FormEvent } from 'react';
import {
  React,
  useState,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  ApiHttpError,
} from './_runtime';
import { zoomLiveUiApi } from './client';

export function ZoomCredentialsCard() {
  const [draft, setDraft] = useState({ accountId: '', clientId: '', clientSecret: '' });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<
    'idle' | 'testing' | { kind: 'real' | 'stub'; accountId: string } | { error: string }
  >('idle');

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('saving');
    setErrMsg(null);
    try {
      await zoomLiveUiApi.upsertCredentials({
        accountId: draft.accountId.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
      });
      setStatus('saved');
      setDraft((s) => ({ ...s, clientSecret: '' }));
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
      await zoomLiveUiApi.removeCredentials();
      setStatus('saved');
      setDraft({ accountId: '', clientId: '', clientSecret: '' });
    } catch (e) {
      setStatus('error');
      setErrMsg(e instanceof ApiHttpError ? e.message : 'No pudimos borrar las credenciales.');
    }
  }

  async function handleTest() {
    setTestStatus('testing');
    try {
      const res = await zoomLiveUiApi.testCredentials();
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
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setDraft({ ...draft, accountId: e.target.value })
              }
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
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setDraft({ ...draft, clientId: e.target.value })
              }
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
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setDraft({ ...draft, clientSecret: e.target.value })
              }
              autoComplete="new-password"
            />
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
