import { stripe, log, loadState, saveState } from './lib2.mjs';
const s = loadState();
const C = s.creador_ES;
if (!s.precio100) {
  const prod = await stripe('POST', '/v1/products', {
    name: 'Curso de prueba (creador ES)',
    metadata: { creador: C },
  });
  const price = await stripe('POST', '/v1/prices', {
    product: prod.id,
    unit_amount: 10000,
    currency: 'eur',
    metadata: { creador: C },
  });
  s.precio100 = price.id;
  saveState(s);
}
const base = {
  success_url: 'https://example.com/ok?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://example.com/cancel',
  customer_email: 'alumna-checkout@example.com',
};
const casos = {
  cs_pago_obo: {
    ...base,
    mode: 'payment',
    line_items: [{ price: s.precio100, quantity: 1 }],
    payment_intent_data: {
      on_behalf_of: C,
      transfer_group: 'cs_pago_obo',
      metadata: { creador: C },
    },
  },
  cs_pago_obo_factura: {
    ...base,
    mode: 'payment',
    line_items: [{ price: s.precio100, quantity: 1 }],
    payment_intent_data: { on_behalf_of: C, transfer_group: 'cs_pago_obo_factura' },
    invoice_creation: { enabled: true, invoice_data: { issuer: { type: 'account', account: C } } },
  },
  cs_pago_obo_tax: {
    ...base,
    mode: 'payment',
    line_items: [{ price: s.precio100, quantity: 1 }],
    payment_intent_data: { on_behalf_of: C },
    automatic_tax: { enabled: true, liability: { type: 'account', account: C } },
  },
  cs_pago_sin_obo_tax_cuenta: {
    ...base,
    mode: 'payment',
    line_items: [{ price: s.precio100, quantity: 1 }],
    automatic_tax: { enabled: true, liability: { type: 'account', account: C } },
  },
  cs_pago_marca: {
    ...base,
    mode: 'payment',
    line_items: [{ price: s.precio100, quantity: 1 }],
    payment_intent_data: { on_behalf_of: C },
    branding_settings: {
      display_name: 'Academia Prueba ES',
      background_color: '#101820',
      button_color: '#cbb779',
    },
  },
  cs_sub_obo: {
    ...base,
    mode: 'subscription',
    line_items: [{ price: s.precio29, quantity: 1 }],
    subscription_data: { on_behalf_of: C, metadata: { creador: C } },
  },
  cs_sub_obo_trial_issuer: {
    ...base,
    mode: 'subscription',
    line_items: [{ price: s.precio29, quantity: 1 }],
    subscription_data: {
      on_behalf_of: C,
      trial_period_days: 7,
      invoice_settings: { issuer: { type: 'account', account: C } },
    },
  },
  cs_sub_obo_tax: {
    ...base,
    mode: 'subscription',
    line_items: [{ price: s.precio29, quantity: 1 }],
    subscription_data: { on_behalf_of: C },
    automatic_tax: { enabled: true, liability: { type: 'account', account: C } },
  },
  cs_sub_sin_obo: {
    ...base,
    mode: 'subscription',
    line_items: [{ price: s.precio29, quantity: 1 }],
  },
};
s.cs = s.cs ?? {};
for (const [k, p] of Object.entries(casos)) {
  const r = await stripe('POST', '/v1/checkout/sessions', p, { soft: true });
  log(
    k,
    r.__error
      ? { error: r.__error.message }
      : {
          id: r.id,
          status: r.status,
          amount_total: r.amount_total,
          automatic_tax: r.automatic_tax,
          branding: r.branding_settings?.display_name,
        },
  );
  if (!r.__error) s.cs[k] = { id: r.id, url: r.url };
}
saveState(s);
