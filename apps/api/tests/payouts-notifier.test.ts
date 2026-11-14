/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Avisos de dinero de los cobros de plataforma (E6): textos en llano (es/en/pt),
 * a quién van y por qué SMTP. Nunca lanzan.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PayoutsEmailNotifier,
  creatorFooter,
  debtChargedTexts,
  disputeOpenedTexts,
  creatorSaleData,
  formatMinor,
  saleMadeTexts,
} from '../src/modules/payouts/payouts-notifier';
import { buildRefundEmail } from '../src/modules/sale-emails/sale-email-render';

const TENANT = '11111111-1111-4111-8111-111111111111';

function deps(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ to: string; subject: string; text: string; html: string; from: string }> = [];
  const smtp = {
    send: vi.fn(
      async (
        _config: unknown,
        input: { to: string; subject: string; text: string; html: string },
        fromName: string,
      ) => {
        sent.push({ ...input, from: fromName });
        return { ok: true };
      },
    ),
  };
  const smtpResolver = {
    resolve: vi.fn(async () => ({
      config: { host: 'smtp.aula' },
      source: 'tenant',
      verified: true,
    })),
    resolveGlobal: vi.fn(() => ({
      config: { host: 'smtp.global' },
      source: 'global',
      verified: false,
    })),
  };
  const prisma = {
    user: {
      findMany: vi.fn(async () => [
        { id: 'u-es', email: 'creadora@aula.test', locale: 'es' },
        { id: 'u-en', email: 'socio@aula.test', locale: 'en-GB' },
        { id: 'u-pt', email: 'socia@escola.test', locale: 'pt-BR' },
      ]),
      findFirst: vi.fn(
        async (): Promise<Record<string, unknown> | null> => ({
          name: 'Marta Ensayo',
          email: 'marta@example.test',
          locale: 'es-ES',
          deletedAt: null,
          status: 'ACTIVE',
        }),
      ),
    },
    userNotificationPreference: {
      findUnique: vi.fn(async (_args?: unknown): Promise<{ enabled: boolean } | null> => null),
    },
    tenantSetting: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    tenant: { findUnique: vi.fn(async () => ({ name: 'Aula de Ana' })) },
    modThemingTenantTheme: { findUnique: vi.fn(async () => null) },
  };
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  const notifier = new PayoutsEmailNotifier({
    prisma: prisma as never,
    logger: logger as never,
    operatorName: 'Didacta',
    operatorAlertEmail: 'cobros@didacta.test',
    smtpResolver: smtpResolver as never,
    smtp: smtp as never,
    tenantResolver: {
      resolveTenantWebBaseUrlForBackground: async () => 'https://ana.test',
    } as never,
    ...overrides,
  });
  return { notifier, sent, smtp, smtpResolver, prisma, logger };
}

describe('textos', () => {
  it('importes con sus decimales, como en el panel de Stripe', () => {
    expect(formatMinor(17500, 'eur', 'es')).toMatch(/175,00\s€/);
    expect(formatMinor(9325, 'eur', 'en')).toBe('€93.25');
    expect(formatMinor(1000, 'jpy', 'en')).toBe('JP¥1,000');
  });

  it('deuda: «Te descontaremos {importe} de tus próximos cobros por {motivo}»', () => {
    const es = debtChargedTexts({
      lang: 'es',
      description: 'Curso de Excel',
      amount: '1,75 €',
      cause: 'refund',
    });
    expect(es.subject).toBe('Te descontaremos 1,75 € de tus próximos cobros');
    expect(es.body).toContain(
      'Por el reembolso de «Curso de Excel», te descontaremos 1,75 € de tus próximos cobros.',
    );
    const lost = debtChargedTexts({
      lang: 'es',
      description: 'Curso',
      amount: '23,40 €',
      cause: 'dispute_lost',
    });
    expect(lost.body).toContain('tasa del banco y comisión de la tarjeta');
    const en = debtChargedTexts({
      lang: 'en',
      description: 'Excel',
      amount: '€1.75',
      cause: 'refund',
    });
    expect(en.subject).toBe("We'll take €1.75 from your next payouts");
  });

  it('disputa: fecha límite y qué pasa con el dinero, sin jerga', () => {
    const es = disputeOpenedTexts({
      lang: 'es',
      operator: 'Didacta',
      description: 'Curso de Excel',
      amount: '100,00 €',
      dueBy: '22 de noviembre de 2026',
    });
    expect(es.body).toContain('antes del 22 de noviembre de 2026');
    // Por defecto la tasa la paga el creador aunque se gane: se dice desde el principio.
    expect(es.body).toContain('el banco se queda su tasa aunque ganemos');
    expect(es.body).not.toContain('te lo devolvemos entero');
    for (const word of ['chargeback', 'dispute', 'Stripe', 'transfer']) {
      expect(es.body).not.toContain(word);
    }
    const platform = disputeOpenedTexts({
      lang: 'es',
      operator: 'Didacta',
      description: 'Curso de Excel',
      amount: '100,00 €',
      dueBy: null,
      wonFeeCharged: false,
    });
    expect(platform.body).toContain('Si el banco nos da la razón, te lo devolvemos entero');
  });

  it('disputa ganada: se ganó y la tasa del banco (importe) se descuenta de los próximos cobros', () => {
    const es = debtChargedTexts({
      lang: 'es',
      description: 'Curso de Excel',
      amount: '20,00 €',
      cause: 'dispute_won',
    });
    expect(es.subject).toBe('Hemos ganado la reclamación de «Curso de Excel»');
    expect(es.body).toContain('nos ha dado la razón');
    expect(es.body).toContain('Esa tasa (20,00 €) se descontará de tus próximos cobros.');
    const en = debtChargedTexts({
      lang: 'en',
      description: 'Excel',
      amount: '€20.00',
      cause: 'dispute_won',
    });
    expect(en.body).toContain('That fee (€20.00) will be taken from your next payouts.');
    for (const word of ['chargeback', 'dispute', 'Stripe', 'transfer', 'payout ']) {
      expect(es.body).not.toContain(word);
    }
  });
});

describe('textos en portugués (pt-BR)', () => {
  it('importes y fechas al estilo brasileño', () => {
    expect(formatMinor(9325, 'eur', 'pt')).toMatch(/^€\s93,25$/);
    expect(formatMinor(17500, 'brl', 'pt')).toMatch(/^R\$\s175,00$/);
  });

  it('disputa: «contestação», fecha límite y qué pasa con el dinero, sin español ni jerga', () => {
    const pt = disputeOpenedTexts({
      lang: 'pt',
      operator: 'Didacta',
      description: 'Curso de Excel',
      amount: '€ 100,00',
      dueBy: '22 de novembro de 2026',
    });
    expect(pt.subject).toBe('Um aluno contestou um pagamento junto ao banco');
    expect(pt.body).toContain('o pagamento de “Curso de Excel” (€ 100,00)');
    expect(pt.body).toContain('até 22 de novembro de 2026');
    expect(pt.body).toContain('o banco fica com a taxa dele mesmo quando ganhamos');
    expect(pt.cta).toBe('Ver minhas vendas');
    const sinDescripcion = disputeOpenedTexts({
      lang: 'pt',
      operator: 'Didacta',
      description: null,
      amount: '€ 1,00',
      dueBy: null,
      wonFeeCharged: false,
    });
    expect(sinDescripcion.body).toContain('“uma venda”');
    expect(sinDescripcion.body).toContain('devolvemos o valor inteiro a você');
    for (const ajeno of ['chargeback', 'dispute', 'Stripe', 'alumno', 'cobros', 'una venta']) {
      expect(`${pt.body}\n${sinDescripcion.body}`, ajeno).not.toContain(ajeno);
    }
  });

  it('deuda y disputa ganada: «recebimentos» y comillas curvas', () => {
    const refund = debtChargedTexts({
      lang: 'pt',
      description: 'Curso de Excel',
      amount: '€ 1,75',
      cause: 'refund',
    });
    expect(refund.subject).toBe('Vamos descontar € 1,75 dos seus próximos recebimentos');
    expect(refund.body).toContain(
      'Por causa do reembolso de “Curso de Excel”, vamos descontar € 1,75 dos seus próximos recebimentos.',
    );
    const lost = debtChargedTexts({
      lang: 'pt',
      description: 'Curso',
      amount: '€ 23,40',
      cause: 'dispute_lost',
    });
    expect(lost.body).toContain('Por causa da contestação de “Curso”');
    expect(lost.body).toContain('taxa do banco e taxa do cartão');
    const won = debtChargedTexts({
      lang: 'pt',
      description: 'Curso de Excel',
      amount: '€ 20,00',
      cause: 'dispute_won',
    });
    expect(won.subject).toBe('Ganhamos a contestação de “Curso de Excel”');
    expect(won.body).toContain(
      'Essa taxa (€ 20,00) será descontada dos seus próximos recebimentos.',
    );
    // Control: el español sigue igual.
    expect(
      debtChargedTexts({ lang: 'es', description: 'X', amount: '1 €', cause: 'refund' }).subject,
    ).toBe('Te descontaremos 1 € de tus próximos cobros');
  });
});

describe('envío', () => {
  it('al creador: a cada administrador en su idioma; lo firma el operador, no su propia academia', async () => {
    const { notifier, sent, smtpResolver } = deps();
    await notifier.debtCharged({
      tenantId: TENANT,
      saleId: null,
      description: 'Curso de Excel',
      amount: 175,
      currency: 'eur',
      cause: 'refund',
    });
    // Ensayo general: el correo de deuda llegaba como «Aula de Ana» a la propia
    // dueña de «Aula de Ana». Ahora escribe Didacta, por su SMTP (el global).
    expect(smtpResolver.resolveGlobal).toHaveBeenCalled();
    expect(smtpResolver.resolve).not.toHaveBeenCalled();
    expect(sent.every((m) => m.from === 'Didacta')).toBe(true);
    expect(sent[0]!.text).toContain('— Didacta');
    expect(sent[0]!.text).not.toContain('— Aula de Ana');
    expect(sent[0]!.text).toContain('Te escribe Didacta porque administras «Aula de Ana».');
    expect(sent[1]!.text).toContain('Didacta is writing to you because you run "Aula de Ana".');
    expect(sent[2]!.text).toContain(
      'Didacta escreve para você porque você administra “Aula de Ana”.',
    );
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['creadora@aula.test', expect.stringMatching(/^Te descontaremos 1,75\s€/)],
      ['socio@aula.test', "We'll take €1.75 from your next payouts"],
      // pt-BR: importe al estilo brasileño y botón en portugués.
      ['socia@escola.test', expect.stringMatching(/^Vamos descontar €\s1,75 dos seus próximos/)],
    ]);
    expect(sent[0]!.text).toContain('https://ana.test/admin/payments');
    expect(sent[2]!.text).toContain('Ver minhas vendas: https://ana.test/admin/payments');
  });

  it('al operador: solo con correo configurado y por el SMTP global', async () => {
    const { notifier, sent, smtpResolver } = deps();
    await notifier.operatorAlert('payouts.debt_alert', { tenantId: TENANT, outstanding: 20000 });
    expect(smtpResolver.resolveGlobal).toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({
        to: 'cobros@didacta.test',
        subject: '[Didacta · cobros] payouts.debt_alert',
      }),
    ]);
    const without = deps({ operatorAlertEmail: null });
    await without.notifier.operatorAlert('payouts.debt_alert', {});
    expect(without.sent).toEqual([]);
  });

  it('sin SMTP global sale por el del aula, con el mismo remitente', async () => {
    const { notifier, sent, smtpResolver } = deps();
    smtpResolver.resolveGlobal.mockReturnValueOnce(null as never);
    await notifier.debtCharged({
      tenantId: TENANT,
      saleId: null,
      description: null,
      amount: 175,
      currency: 'eur',
      cause: 'refund',
    });
    expect(smtpResolver.resolve).toHaveBeenCalledWith(TENANT);
    expect(sent.map((m) => m.from)).toEqual(['Didacta', 'Didacta', 'Didacta']);
  });

  it('sin SMTP o con un fallo, no lanza: queda en el log', async () => {
    const { notifier, smtpResolver, logger } = deps();
    smtpResolver.resolveGlobal.mockReturnValueOnce(null as never);
    smtpResolver.resolve.mockResolvedValueOnce(null as never);
    await expect(
      notifier.disputeOpened({
        tenantId: TENANT,
        saleId: 's',
        description: null,
        amount: 10000,
        currency: 'eur',
        evidenceDueBy: null,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    const broken = deps();
    broken.prisma.user.findMany.mockRejectedValueOnce(new Error('base caída'));
    await expect(
      broken.notifier.debtCharged({
        tenantId: TENANT,
        saleId: null,
        description: null,
        amount: 1,
        currency: 'eur',
        cause: 'refund',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('aviso de VENTA a quien administra el aula', () => {
  const SALE = {
    tenantId: TENANT,
    saleId: 'venta-1',
    kind: 'course' as const,
    description: 'Torno para principiantes',
    amount: 4900,
    currency: 'eur',
    buyerEmail: 'marta@example.test',
    heldForTaxData: false,
  };

  it('textos: importe, producto y comprador en los tres idiomas, sin español fuera del es', () => {
    const es = saleMadeTexts({
      lang: 'es',
      kind: 'course',
      product: 'Torno para principiantes',
      amount: formatMinor(4900, 'eur', 'es'),
      buyer: 'Marta Ensayo',
      heldForTaxData: false,
    });
    expect(es.subject).toMatch(/^Nueva venta: «Torno para principiantes» \(49,00\s€\)$/);
    expect(es.title).toBe('Has vendido «Torno para principiantes»');
    expect(es.body).toMatch(/^Marta Ensayo ha comprado «Torno para principiantes» por 49,00\s€\./);
    expect(es.body).not.toContain('retenido');
    const en = saleMadeTexts({
      lang: 'en',
      kind: 'renewal',
      product: 'Monthly',
      amount: formatMinor(2900, 'gbp', 'en'),
      buyer: 'Olivia',
      heldForTaxData: true,
    });
    expect(en.subject).toBe('Renewal: "Monthly" (£29.00)');
    expect(en.body).toContain('Olivia renewed "Monthly": £29.00.');
    expect(en.body).toContain(
      'until you complete your tax details, the money from this sale stays on hold',
    );
    const pt = saleMadeTexts({
      lang: 'pt',
      kind: 'membership',
      product: 'Mensal',
      amount: formatMinor(2900, 'eur', 'pt'),
      buyer: 'Beatriz',
      heldForTaxData: true,
    });
    expect(pt.subject).toMatch(/^Nova venda: “Mensal” \(€\s29,00\)$/);
    expect(pt.title).toBe('Novo membro em “Mensal”');
    expect(pt.body).toContain('Em Vendas');
    expect(pt.body).toContain('dados fiscais');
    for (const t of [en, pt]) {
      expect(`${t.subject} ${t.title} ${t.body} ${t.cta}`).not.toMatch(/venta|Ventas|cobros|«/);
    }
  });

  it('campana + correo a cada administrador, en su idioma, con el nombre del comprador', async () => {
    const hubSent: Array<Record<string, unknown>> = [];
    const hub = { send: vi.fn(async (n: Record<string, unknown>) => void hubSent.push(n)) };
    const { notifier, sent } = deps({ hub: () => hub });
    await notifier.saleMade(SALE);

    expect(hubSent.map((n) => [n['to'], n['templateKey'], n['category'], n['channel']])).toEqual([
      ['u-es', 'payouts.sale.course', 'SYSTEM', 'in-app'],
      ['u-en', 'payouts.sale.course', 'SYSTEM', 'in-app'],
      ['u-pt', 'payouts.sale.course', 'SYSTEM', 'in-app'],
    ]);
    expect(hubSent[0]!['variables']).toMatchObject({
      product: 'Torno para principiantes',
      buyer: 'Marta Ensayo',
      amount: { hubValue: 'money', cents: 4900, currency: 'eur' },
      held: false,
    });
    expect(sent.map((m) => [m.to, m.from])).toEqual([
      ['creadora@aula.test', 'Didacta'],
      ['socio@aula.test', 'Didacta'],
      ['socia@escola.test', 'Didacta'],
    ]);
    expect(sent[0]!.subject).toMatch(/^Nueva venta: «Torno para principiantes»/);
    expect(sent[0]!.text).toContain('Marta Ensayo ha comprado');
    expect(sent[0]!.text).toContain('Ver mis ventas: https://ana.test/admin/payments');
    expect(sent[1]!.subject).toMatch(/^New sale: "Torno para principiantes"/);
    expect(sent[2]!.subject).toMatch(/^Nova venda: “Torno para principiantes”/);
  });

  it('desglose del reparto: comisión de la tarjeta, la de Didacta (5 %), lo que llega y cuándo', async () => {
    const { notifier, sent } = deps();
    await notifier.saleMade({
      ...SALE,
      sourceRef: '7c1e3a90-0000-4000-8000-00003f2a9c1b',
      chargedAt: new Date('2026-11-14T09:30:00Z'),
      split: {
        currency: 'eur',
        gross: 4900,
        stripeFee: 99,
        platformFee: 245,
        feeBpsApplied: 500,
        debtNetted: 0,
        creatorNet: 4556,
        transferAmount: 4556,
        status: 'READY',
        estimatedArrival: new Date('2026-11-21T00:00:00Z'),
      },
    });
    const es = sent[0]!;
    expect(es.text).toContain('Pedido: 3F2A9C1B');
    expect(es.text).toMatch(/Pagado por el alumno: 49,00\s€/);
    expect(es.text).toMatch(/Comisión de la tarjeta: −0,99\s€/);
    expect(es.text).toMatch(/5 % de Didacta: −2,45\s€/);
    expect(es.text).toMatch(/Te llega: 45,56\s€/);
    expect(es.text).toContain('Llegará a tu banco hacia el 21 de noviembre de 2026.');
    expect(es.text).toContain('Marta Ensayo');
    expect(es.text).toContain('marta@example.test');
    expect(es.html).toContain('Nueva venta en Aula de Ana');
    const en = sent[1]!;
    expect(en.text).toMatch(/Didacta 5% fee: −€2\.45/);
    expect(en.text).toContain('It will reach your bank around 21 November 2026.');
    const pt = sent[2]!;
    expect(pt.text).toMatch(/5% da Didacta: −€\s2,45/);
    expect(pt.text).toContain('Chega ao seu banco por volta de 21 de novembro de 2026.');
  });

  it('sin la comisión de la tarjeta todavía: «Calculando…», nunca un importe inventado', () => {
    const data = creatorSaleData(
      {
        ...SALE,
        split: {
          currency: 'eur',
          gross: null,
          stripeFee: null,
          platformFee: null,
          feeBpsApplied: null,
          currentFeeBps: 500,
          debtNetted: 0,
          creatorNet: null,
          transferAmount: null,
          status: 'AWAITING_FEE',
          estimatedArrival: null,
        },
      },
      'es',
      {
        operator: 'Didacta',
        academy: 'Aula de Ana',
        timeZone: 'Europe/Madrid',
        buyerName: 'Marta Ensayo',
        salesUrl: 'https://ana.test/admin/payments',
        footer: null,
      },
    );
    expect(data.cardFee).toBeNull();
    expect(data.youReceive).toBeNull();
    expect(data.status).toBe('pending');
    expect(data.feeBps).toBe(500);
    const held = creatorSaleData({ ...SALE, heldForTaxData: true }, 'es', {
      operator: 'Didacta',
      academy: 'Aula de Ana',
      timeZone: 'Europe/Madrid',
      buyerName: null,
      salesUrl: null,
      footer: null,
    });
    expect(held.status).toBe('held_tax_data');
  });

  it('respeta las preferencias: quien apagó el correo de «Sistema» no lo recibe', async () => {
    const { notifier, sent, prisma } = deps();
    prisma.userNotificationPreference.findUnique.mockImplementation(async (args?: unknown) =>
      (args as { where: { tenantId_userId_category_channel: { userId: string } } }).where
        .tenantId_userId_category_channel.userId === 'u-en'
        ? { enabled: false }
        : null,
    );
    await notifier.saleMade(SALE);
    expect(sent.map((m) => m.to)).toEqual(['creadora@aula.test', 'socia@escola.test']);
  });

  it('sin nombre, el correo del comprador; sin campana, solo el correo; nunca lanza', async () => {
    const { notifier, sent, prisma } = deps();
    prisma.user.findFirst.mockResolvedValueOnce({ name: null });
    await expect(notifier.saleMade({ ...SALE, kind: 'membership' })).resolves.toBeUndefined();
    expect(sent[0]!.text).toContain('marta@example.test se ha unido a «Torno para principiantes»');
  });
});

describe('aviso al ALUMNO al reembolsarle', () => {
  const REFUND = {
    tenantId: TENANT,
    saleId: 'venta-1',
    refundId: 'reembolso-1',
    kind: 'course' as const,
    description: 'Torno para principiantes',
    amount: 4900,
    currency: 'eur',
    buyerEmail: 'Marta@Example.test',
    full: true,
  };

  it('textos: total pierde el acceso, parcial lo conserva; membresía no habla de acceso', () => {
    const base = {
      timeZone: 'Europe/Madrid',
      buyerName: 'Marta Ensayo',
      buyerEmail: 'marta@example.com',
      orderRef: '3F2A9C1B',
      refundedAt: new Date('2026-11-14T10:00:00Z'),
      currency: 'eur',
      refunded: 4900,
      originallyPaid: 4900,
      paymentMethod: { type: 'card', brand: 'visa', last4: '4242' },
    } as const;
    const brand = (tenantName: string) => ({ tenantName, logoUrl: null, brandColor: '#1E5AA8' });
    const full = buildRefundEmail(brand('Cerámica con Lucía'), {
      ...base,
      lang: 'es',
      academy: 'Cerámica con Lucía',
      product: { title: 'Torno', kind: 'course' },
      full: true,
      seller: { name: 'Cerámica con Lucía', legalName: null, contactEmail: null },
    });
    expect(full.subject).toMatch(/^Te hemos devuelto 49,00\s€ de «Torno»$/);
    expect(full.text).toMatch(/Cerámica con Lucía te ha devuelto 49,00\s€/);
    expect(full.text).toContain('ya no tienes acceso al curso');
    expect(full.text).toContain('Pedido: 3F2A9C1B');
    expect(full.text).toContain('Se devuelve a: Visa ···· 4242');
    const partial = buildRefundEmail(brand('Sourdough with Sam'), {
      ...base,
      lang: 'en',
      academy: 'Sourdough with Sam',
      currency: 'gbp',
      refunded: 1000,
      originallyPaid: 4900,
      product: { title: 'Bread', kind: 'course' },
      full: false,
      seller: { name: 'Sourdough with Sam', legalName: null, contactEmail: null },
    });
    expect(partial.text).toContain('You still have access to the course.');
    expect(partial.text).toContain('You paid: £49.00');
    const membership = buildRefundEmail(brand('Escola de Violão da Ana'), {
      ...base,
      lang: 'pt',
      academy: 'Escola de Violão da Ana',
      refunded: 2900,
      originallyPaid: 2900,
      product: { title: 'Mensal', kind: 'membership' },
      full: true,
      seller: { name: 'Escola de Violão da Ana', legalName: null, contactEmail: null },
    });
    expect(membership.subject).toMatch(/^Devolvemos €\s29,00 de “Mensal”$/);
    expect(membership.text).not.toMatch(/acesso ao curso/);
    expect(`${membership.subject} ${membership.text}`).not.toMatch(/devuelto|tarjeta|«/);
  });

  it('va al alumno, en su idioma, con la marca y el SMTP de la academia', async () => {
    const { notifier, sent, smtpResolver } = deps();
    await notifier.refundIssued(REFUND);
    expect(smtpResolver.resolve).toHaveBeenCalledWith(TENANT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'marta@example.test', from: 'Aula de Ana' });
    expect(sent[0]!.subject).toMatch(/^Te hemos devuelto 49,00\s€ de «Torno para principiantes»$/);
    // Con aspecto de recibo y la marca del aula: importe grande, pedido y vendedor.
    expect(sent[0]!.html).toContain('Reembolso de Aula de Ana');
    expect(sent[0]!.text).toContain('Vendido por'.toUpperCase());
    expect(sent[0]!.text).toContain('ya no tienes acceso al curso');
  });

  it('sin cuenta, en el idioma del aula; a una cuenta suspendida no se le escribe', async () => {
    const noUser = deps();
    noUser.prisma.user.findFirst.mockResolvedValueOnce(null);
    noUser.prisma.tenantSetting.findUnique.mockResolvedValue({ valueJson: 'en' });
    await noUser.notifier.refundIssued({ ...REFUND, full: false });
    expect(noUser.sent[0]!.to).toBe('Marta@Example.test');
    expect(noUser.sent[0]!.subject).toMatch(/^We've refunded you €49\.00/);

    const suspended = deps();
    suspended.prisma.user.findFirst.mockResolvedValueOnce({
      email: 'marta@example.test',
      locale: 'es-ES',
      deletedAt: null,
      status: 'SUSPENDED',
    });
    await suspended.notifier.refundIssued(REFUND);
    expect(suspended.sent).toEqual([]);
  });
});

describe('pie de los avisos del operador', () => {
  it('dice de qué academia se trata', () => {
    expect(creatorFooter('es', 'Didacta', 'Cerámica con Lucía')).toBe(
      'Te escribe Didacta porque administras «Cerámica con Lucía».',
    );
  });
});
