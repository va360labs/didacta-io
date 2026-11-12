/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { linkedInAddUrl } from '@/lib/certificate-linkedin';
import type { MemberReferralStats } from '@/lib/referrals';
import { showCourseCertificateCard } from './course-certificate-card';
import { referralFigures } from './simple-referrals';

describe('certificado dentro del curso (modo sencillo)', () => {
  it('solo con el curso terminado, el certificado emitido y en modo sencillo', () => {
    expect(
      showCourseCertificateCard({
        simple: true,
        enrollmentStatus: 'COMPLETED',
        hasCertificate: true,
      }),
    ).toBe(true);
    expect(
      showCourseCertificateCard({ simple: true, enrollmentStatus: 'ACTIVE', hasCertificate: true }),
    ).toBe(false);
    expect(
      showCourseCertificateCard({
        simple: true,
        enrollmentStatus: 'COMPLETED',
        hasCertificate: false,
      }),
    ).toBe(false);
    // Control: en modo completo el curso no cambia.
    expect(
      showCourseCertificateCard({
        simple: false,
        enrollmentStatus: 'COMPLETED',
        hasCertificate: true,
      }),
    ).toBe(false);
  });

  it('el enlace de LinkedIn apunta a la verificación pública del certificado', () => {
    const url = new URL(
      linkedInAddUrl(
        { id: 'c1', number: 'CERT-001', issuedAt: '2026-11-12T10:00:00.000Z', snapshot: null },
        'Taller de Acuarela',
        'Acuarela desde cero',
        'https://aula.example',
      ),
    );
    expect(url.origin).toBe('https://www.linkedin.com');
    expect(url.searchParams.get('certUrl')).toBe('https://aula.example/verificar/c1');
    expect(url.searchParams.get('name')).toBe('Acuarela desde cero');
    expect(url.searchParams.get('organizationName')).toBe('Taller de Acuarela');
    expect(url.searchParams.get('issueYear')).toBe('2026');
    expect(url.searchParams.get('issueMonth')).toBe('11');
  });
});

describe('cifras de «Invita y gana» (solo datos reales del módulo)', () => {
  function stats(over: Partial<MemberReferralStats> = {}): MemberReferralStats {
    return {
      programActive: true,
      memberCopy: null,
      commissionBps: 2000,
      scope: 'RECURRING',
      recurringMonths: null,
      minPayoutCents: 0,
      attributionWindowDays: 30,
      code: 'abc',
      clicks: 12,
      referrals: 3,
      totals: { pendingCents: 500, approvedCents: 1200, paidCents: 3000 },
      commissions: [
        {
          id: '1',
          amountCents: 580,
          baseAmountCents: 2900,
          currency: 'eur',
          status: 'PAID',
          createdAt: '2026-11-03T10:00:00.000Z',
        },
        {
          id: '2',
          amountCents: 580,
          baseAmountCents: 2900,
          currency: 'eur',
          status: 'REVOKED',
          createdAt: '2026-11-05T10:00:00.000Z',
        },
        {
          id: '3',
          amountCents: 1000,
          baseAmountCents: 5000,
          currency: 'eur',
          status: 'APPROVED',
          createdAt: '2026-10-20T10:00:00.000Z',
        },
      ],
      payouts: [],
      ...over,
    };
  }

  it('ganado = confirmado + pagado; lo pendiente va aparte', () => {
    const f = referralFigures(stats(), new Date('2026-11-12T00:00:00.000Z'));
    expect(f.earnedCents).toBe(4200);
    expect(f.pendingCents).toBe(500);
    expect(f.people).toBe(3);
    expect(f.currency).toBe('EUR');
  });

  it('«este mes» suma las comisiones del mes sin las anuladas', () => {
    expect(referralFigures(stats(), new Date('2026-11-12T00:00:00.000Z')).thisMonthCents).toBe(580);
    expect(referralFigures(stats(), new Date('2026-10-28T00:00:00.000Z')).thisMonthCents).toBe(
      1000,
    );
  });

  it('sin comisiones: todo a cero y moneda por defecto', () => {
    const f = referralFigures(
      stats({ commissions: [], totals: { pendingCents: 0, approvedCents: 0, paidCents: 0 } }),
    );
    expect(f).toMatchObject({ earnedCents: 0, thisMonthCents: 0, currency: 'EUR' });
  });
});
