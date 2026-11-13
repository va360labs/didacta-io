import { stripe, log, loadState, saveState } from './lib.mjs';
const s = loadState();
const meta = { creado_por: 'auditoria-comision-2026-11-12' };
if (!s.std) {
  const a = await stripe(
    'POST',
    '/v1/accounts',
    {
      type: 'standard',
      country: 'ES',
      email: 'creador-standard+auditoria@example.com',
      metadata: meta,
    },
    { soft: true },
  );
  log(
    'standard',
    a.__error ?? {
      id: a.id,
      type: a.type,
      controller: a.controller,
      capabilities: a.capabilities,
      charges_enabled: a.charges_enabled,
    },
  );
  if (!a.__error) s.std = a.id;
}
if (!s.exp) {
  const a = await stripe(
    'POST',
    '/v1/accounts',
    {
      type: 'express',
      country: 'ES',
      email: 'creador-express+auditoria@example.com',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: meta,
    },
    { soft: true },
  );
  log(
    'express',
    a.__error ?? {
      id: a.id,
      type: a.type,
      controller: a.controller,
      capabilities: a.capabilities,
      charges_enabled: a.charges_enabled,
    },
  );
  if (!a.__error) s.exp = a.id;
}
saveState(s);
// enlace de onboarding (demuestra que el alta alojada funciona)
for (const k of ['std', 'exp']) {
  if (!s[k]) continue;
  const l = await stripe(
    'POST',
    '/v1/account_links',
    {
      account: s[k],
      type: 'account_onboarding',
      refresh_url: 'https://example.com/refresh',
      return_url: 'https://example.com/return',
    },
    { soft: true },
  );
  log(
    'account_link ' + k,
    l.__error ?? { ok: true, url_host: new URL(l.url).host, expires_at: l.expires_at },
  );
}
// intento de cobro directo en la standard recién creada, sin onboarding
const pi = await stripe(
  'POST',
  '/v1/payment_intents',
  {
    amount: 10000,
    currency: 'eur',
    payment_method: 'pm_card_visa',
    confirm: true,
    payment_method_types: ['card'],
    application_fee_amount: 1000,
    description: 'auditoria: curso suelto 100 EUR, comision 10%',
  },
  { account: s.std, soft: true },
);
log(
  'cobro directo en standard sin onboarding',
  pi.__error
    ? { error: pi.__error.code, msg: pi.__error.message }
    : { id: pi.id, status: pi.status, fee: pi.application_fee_amount, charge: pi.latest_charge },
);
