'use client';

/**
 * Ajustes de avisos de suscripción (mod.payment-connections).
 *
 * Configuración del barrido diario de avisos: cada día a las 9:00 se envía a los
 * admins un resumen de suscripciones y a los miembros un aviso 7 días antes de
 * cada cobro con un enlace para cancelar. Como las claves de Stripe conectadas
 * son de solo lectura, el enlace del Customer Portal se pega aquí a mano.
 *
 * Solo super_admin. Todo el dato viene en vivo de la API (BD real). Cero datos
 * de cartón.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { subscriptionsDashboardApi } from '@/lib/payment-connections';

export function SubscriptionAlertsSettings() {
  const [portalUrl, setPortalUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = authStorage.getAccessToken();
    if (!t) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const { url } = await subscriptionsDashboardApi.getCancelPortalUrl(t);
        setPortalUrl(url ?? '');
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? e.message : 'No pudimos cargar la configuración de avisos.',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { url } = await subscriptionsDashboardApi.setCancelPortalUrl(t, portalUrl.trim());
      setPortalUrl(url ?? '');
      setNotice('Enlace guardado.');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar el enlace.');
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    if (
      !window.confirm(
        'Se enviará el resumen a los admins y los avisos pendientes a los miembros. ¿Continuar?',
      )
    )
      return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      await subscriptionsDashboardApi.runDailyNow(t);
      setNotice('Barrido lanzado.');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos lanzar el barrido.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avisos de suscripción</CardTitle>
        <p className="mt-1 text-sm text-text-muted">
          Cada día a las 9:00 recibes por email un resumen de suscripciones activas y próximas a
          caducar. A los miembros se les avisa 7 días antes de cada cobro con un enlace para
          cancelar.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {notice}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cancel-portal-url">Enlace del Customer Portal de Stripe</Label>
          <Input
            id="cancel-portal-url"
            value={portalUrl}
            onChange={(e) => setPortalUrl(e.target.value)}
            placeholder="https://billing.stripe.com/p/login/..."
            autoComplete="off"
            spellCheck={false}
            disabled={loading || saving}
          />
          <p className="text-xs text-text-muted">
            Las claves de Stripe conectadas son de solo lectura, así que pega aquí tu enlace del
            Customer Portal (Stripe → Configuración → Facturación → Portal de cliente). Se incluirá
            en el aviso de cancelación.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} disabled={loading || saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button variant="secondary" onClick={() => void runNow()} disabled={running}>
            {running ? 'Enviando…' : 'Probar envío ahora'}
          </Button>
        </div>
        <p className="text-xs text-text-muted">Envía de verdad los emails pendientes.</p>
      </CardContent>
    </Card>
  );
}
