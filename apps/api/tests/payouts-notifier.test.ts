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
  debtChargedTexts,
  disputeOpenedTexts,
  formatMinor,
} from '../src/modules/payouts/payouts-notifier';

const TENANT = '11111111-1111-4111-8111-111111111111';

function deps(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const smtp = {
    send: vi.fn(async (_config: unknown, input: { to: string; subject: string; text: string }) => {
      sent.push(input);
      return { ok: true };
    }),
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
        { email: 'creadora@aula.test', locale: 'es' },
        { email: 'socio@aula.test', locale: 'en-GB' },
        { email: 'socia@escola.test', locale: 'pt-BR' },
      ]),
    },
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
  it('al creador: a cada administrador en su idioma, con el SMTP del aula', async () => {
    const { notifier, sent, smtpResolver } = deps();
    await notifier.debtCharged({
      tenantId: TENANT,
      saleId: null,
      description: 'Curso de Excel',
      amount: 175,
      currency: 'eur',
      cause: 'refund',
    });
    expect(smtpResolver.resolve).toHaveBeenCalledWith(TENANT);
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

  it('sin SMTP o con un fallo, no lanza: queda en el log', async () => {
    const { notifier, smtpResolver, logger } = deps();
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
