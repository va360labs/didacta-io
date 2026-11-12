import { describe, expect, it } from 'vitest';
import {
  accountIdOfEvent,
  isAccountEvent,
  minimalEventPayload,
  parsePlatformEvent,
} from '../src/account-events.js';
import { PayoutsWebhookPayloadInvalidError } from '../src/errors.js';

const ACCT = 'acct_1UatqsGVFsn6IQLd';

describe('eventos de cuenta del webhook de plataforma', () => {
  it.each([
    ['account.updated', { account: ACCT }],
    ['account.updated', { data: { object: { id: ACCT } } }],
    ['capability.updated', { account: ACCT }],
    ['capability.updated', { data: { object: { account: ACCT, id: 'card_payments' } } }],
    [
      'v2.core.account[requirements].updated',
      { related_object: { id: ACCT, type: 'v2.core.account' } },
    ],
    [
      'v2.core.account[configuration.merchant].capability_status_updated',
      { related_object: { id: ACCT, type: 'v2.core.account' } },
    ],
    ['v2.core.account.closed', { related_object: { id: ACCT, type: 'v2.core.account' } }],
    [
      'v2.core.account_person.updated',
      { related_object: { id: 'person_1', type: 'v2.core.account_person' }, context: ACCT },
    ],
  ])('%s → acct_', (type, extra) => {
    expect(isAccountEvent(type)).toBe(true);
    expect(accountIdOfEvent({ id: 'evt_1', type, livemode: false, ...extra })).toBe(ACCT);
  });

  it('tipos de dinero no son de cuenta en E2', () => {
    for (const type of ['charge.updated', 'checkout.session.completed', 'payout.failed']) {
      expect(isAccountEvent(type)).toBe(false);
      expect(accountIdOfEvent({ id: 'evt_1', type, livemode: false, account: ACCT })).toBeNull();
    }
  });

  it('un acct_ mal formado no se acepta', () => {
    expect(
      accountIdOfEvent({
        id: 'evt_1',
        type: 'account.updated',
        livemode: false,
        account: "acct_x'; drop",
      }),
    ).toBeNull();
  });

  it('parsePlatformEvent exige id evt_, tipo y livemode', () => {
    expect(parsePlatformEvent('{"id":"evt_1","type":"account.updated","livemode":false}').id).toBe(
      'evt_1',
    );
    for (const raw of [
      'no json',
      '[]',
      '{"id":"x","type":"a","livemode":false}',
      '{"id":"evt_1","livemode":false}',
      '{"id":"evt_1","type":"a"}',
    ]) {
      expect(() => parsePlatformEvent(raw), raw).toThrow(PayoutsWebhookPayloadInvalidError);
    }
  });

  it('lo archivado no lleva data.object (datos personales del creador)', () => {
    const payload = minimalEventPayload({
      id: 'evt_1',
      type: 'account.updated',
      livemode: false,
      account: ACCT,
      data: { object: { id: ACCT, individual: { first_name: 'Jenny' } } },
    });
    expect(payload).not.toHaveProperty('data');
    expect(JSON.stringify(payload)).not.toContain('Jenny');
  });
});
