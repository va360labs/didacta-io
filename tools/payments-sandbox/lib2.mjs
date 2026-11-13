import { testKey } from './lib.mjs';
const key = testKey();
export const PREVIEW = '2026-10-28.preview';
// API v2 (JSON)
export async function v2(method, p, body, opts = {}) {
  const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': opts.version ?? PREVIEW };
  if (opts.account) headers['Stripe-Context'] = opts.account;
  let url = `https://api.stripe.com${p}`;
  const init = { method, headers };
  if (method !== 'GET' && body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) return { __error: json.error ?? json, status: res.status };
  return json;
}
export { stripe, log, loadState, saveState, sleep } from './lib.mjs';
export const bt = async (stripe, id, opts) => {
  if (!id) return null;
  const b = await stripe(
    'GET',
    '/v1/balance_transactions/' + (typeof id === 'string' ? id : id.id),
    {},
    opts,
  );
  return {
    id: b.id,
    type: b.type,
    amount: b.amount,
    fee: b.fee,
    net: b.net,
    currency: b.currency,
    exchange_rate: b.exchange_rate,
    available_on: new Date(b.available_on * 1000).toISOString().slice(0, 10),
    status: b.status,
    fee_details: b.fee_details.map(
      (f) => `${f.type}:${f.amount}${f.currency}${f.description ? ' (' + f.description + ')' : ''}`,
    ),
  };
};
