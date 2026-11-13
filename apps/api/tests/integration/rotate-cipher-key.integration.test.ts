/**
 * Rotación de la clave maestra de cifrado contra Postgres REAL.
 *
 * La herramienta recifra en una transacción todo lo que la aplicación guarda
 * cifrado (tenant_setting, core_instance_setting, mod_secret). Aquí se prueba
 * contra la base de verdad, con RLS aplicada y conectando también como el rol
 * de la aplicación: esas tablas tienen RLS forzada y un `SELECT` sin contexto
 * de aula devuelve cero filas, así que una herramienta que no asuma el rol
 * correcto «rotaría» nada y diría que todo ha ido bien.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`
 * (docker compose -f docker-compose.test.yml up -d).
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RotationAbortedError, rotateCipherKey } from '../../src/maintenance/rotate-cipher-key';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

// La clave «actual» es la del resto de la suite de integración: así las filas
// cifradas que hayan dejado otros tests se rotan y se devuelven a su sitio con
// las de este, en vez de aparecer como ilegibles.
const OLD_KEY = process.env['TENANT_SETTINGS_ENC_KEY'] ?? '0'.repeat(64);
const NEW_KEY = '5'.repeat(32) + 'c'.repeat(32);
const OTHER_KEY = 'e'.repeat(64);

describeWithDb('rotateCipherKey — Postgres real, RLS aplicada', () => {
  let admin: PrismaClient;
  let appDb: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  const stamp = Date.now();
  const SECRETS = {
    stripeA: JSON.stringify({ secretKey: 'sk_de-A', webhookSecret: 'whsec_de-A' }),
    smtpB: JSON.stringify({ host: 'smtp.b.test', pass: 'contraseña-ñ-€' }),
    instance: JSON.stringify({ license: 'clave-de-licencia' }),
    module: 'app-password del migrador',
    payee: JSON.stringify({
      fullName: 'Lucía Pérez',
      taxId: '12345678Z',
      iban: 'ES9121000418450200051332',
    }),
  };
  const ids = {
    stripeA: randomUUID(),
    smtpB: randomUUID(),
    plainA: randomUUID(),
    instance: randomUUID(),
    module: randomUUID(),
    payee: randomUUID(),
    payeeUser: randomUUID(),
  };

  type SeededTable =
    | 'tenant_setting'
    | 'core_instance_setting'
    | 'mod_secret'
    | 'mod_referrals_member';

  const enc = (key: string, plaintext: string) => new SecretCipherService(key).encrypt(plaintext);

  async function readSecret(table: SeededTable, id: string, key: string): Promise<string | null> {
    const cols =
      table === 'mod_secret'
        ? 'ciphertext AS c, iv, tag'
        : table === 'mod_referrals_member'
          ? 'payee_cipher AS c, payee_iv AS iv, payee_tag AS tag'
          : 'value_cipher AS c, value_iv AS iv, value_tag AS tag';
    const rows = await admin.$queryRawUnsafe<
      Array<{ c: Uint8Array; iv: Uint8Array; tag: Uint8Array }>
    >(`SELECT ${cols} FROM "${table}" WHERE id = $1::uuid`, id);
    const row = rows[0];
    if (!row) throw new Error(`fila ${table}/${id} no encontrada`);
    try {
      return new SecretCipherService(key).decrypt({
        cipher: Buffer.from(row.c),
        iv: Buffer.from(row.iv),
        tag: Buffer.from(row.tag),
      });
    } catch {
      return null;
    }
  }

  /** Lo que tiene que descifrar cada fila sembrada. */
  const SEEDED: Array<[SeededTable, string, string]> = [
    ['tenant_setting', ids.stripeA, SECRETS.stripeA],
    ['tenant_setting', ids.smtpB, SECRETS.smtpB],
    ['core_instance_setting', ids.instance, SECRETS.instance],
    ['mod_secret', ids.module, SECRETS.module],
    // Datos de cobro de un alumno de referidos (nombre, NIF, IBAN).
    ['mod_referrals_member', ids.payee, SECRETS.payee],
  ];

  async function expectAllDecryptWith(key: string, other: string) {
    for (const [table, id, plaintext] of SEEDED) {
      expect(await readSecret(table, id, key), `${table} con la clave esperada`).toBe(plaintext);
      expect(await readSecret(table, id, other), `${table} con la otra clave`).toBeNull();
    }
  }

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    appDb = new PrismaClient({ datasources: { db: { url: prepared.appUrl } } });
    await appDb.$connect();

    tenantA = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `rot-a-${stamp}`, name: 'Rotación A' },
      })
    ).id;
    tenantB = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `rot-b-${stamp}`, name: 'Rotación B' },
      })
    ).id;

    const a = enc(OLD_KEY, SECRETS.stripeA);
    const b = enc(OLD_KEY, SECRETS.smtpB);
    await admin.tenantSetting.createMany({
      data: [
        {
          id: ids.stripeA,
          tenantId: tenantA,
          moduleName: 'billing',
          key: 'stripe',
          isSecret: true,
          valueCipher: a.cipher,
          valueIv: a.iv,
          valueTag: a.tag,
        },
        {
          id: ids.smtpB,
          tenantId: tenantB,
          moduleName: 'notifications',
          key: 'smtp',
          isSecret: true,
          valueCipher: b.cipher,
          valueIv: b.iv,
          valueTag: b.tag,
        },
        // Un ajuste en claro: no es asunto de la rotación.
        {
          id: ids.plainA,
          tenantId: tenantA,
          moduleName: 'billing',
          key: 'stripe_meta',
          isSecret: false,
          valueJson: { verifiedAt: '2026-11-12T00:00:00.000Z' },
        },
      ],
    });
    const i = enc(OLD_KEY, SECRETS.instance);
    await admin.instanceSetting.create({
      data: {
        id: ids.instance,
        scope: `rot-${stamp}`,
        key: 'secreto',
        isSecret: true,
        valueCipher: i.cipher,
        valueIv: i.iv,
        valueTag: i.tag,
      },
    });
    const m = enc(OLD_KEY, SECRETS.module);
    await admin.modSecret.create({
      data: {
        id: ids.module,
        tenantId: tenantB,
        moduleId: 'mod.rotacion',
        secretKey: `k-${stamp}`,
        ciphertext: m.cipher,
        iv: m.iv,
        tag: m.tag,
        approxValueBytes: SECRETS.module.length,
      },
    });
    const p = enc(OLD_KEY, SECRETS.payee);
    await admin.modReferralsMember.create({
      data: {
        id: ids.payee,
        tenantId: tenantA,
        userId: ids.payeeUser,
        payeeCipher: p.cipher,
        payeeIv: p.iv,
        payeeTag: p.tag,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.modReferralsMember.deleteMany({ where: { id: ids.payee } });
    await admin?.modSecret.deleteMany({ where: { id: ids.module } });
    await admin?.instanceSetting.deleteMany({ where: { id: ids.instance } });
    await admin?.tenantSetting.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await admin?.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await appDb?.$disconnect();
    await admin?.$disconnect();
  });

  it('control: el rol de la aplicación, sin más, NO ve estas filas (RLS filtra de verdad)', async () => {
    expect(
      await appDb.tenantSetting.count({ where: { id: { in: [ids.stripeA, ids.smtpB] } } }),
    ).toBe(0);
    expect(
      await admin.tenantSetting.count({ where: { id: { in: [ids.stripeA, ids.smtpB] } } }),
    ).toBe(2);
  });

  it('ensayo conectando como didacta_app: cuenta las filas de TODAS las aulas y no cambia nada', async () => {
    const report = await rotateCipherKey(appDb, { oldKey: OLD_KEY, newKey: NEW_KEY, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.committed).toBe(false);
    // Asumió el rol que ve todo: sin eso habría contado cero.
    expect(report.dbRole).toBe('didacta_super');
    expect(report.tables['tenant_setting']!.reencrypted).toBeGreaterThanOrEqual(2);
    expect(report.tables['core_instance_setting']!.reencrypted).toBeGreaterThanOrEqual(1);
    expect(report.tables['mod_secret']!.reencrypted).toBeGreaterThanOrEqual(1);
    expect(report.unreadable).toEqual([]);

    // La transacción se deshizo: todo sigue cifrado con la clave vieja.
    await expectAllDecryptWith(OLD_KEY, NEW_KEY);
  });

  it('una fila que no descifra con ninguna clave ABORTA y no deja nada a medias', async () => {
    const rota = enc(OTHER_KEY, 'cifrado con una clave que ya no existe');
    const rotaId = randomUUID();
    await admin.tenantSetting.create({
      data: {
        id: rotaId,
        tenantId: tenantA,
        moduleName: 'zoom-live',
        key: 'credentials',
        isSecret: true,
        valueCipher: rota.cipher,
        valueIv: rota.iv,
        valueTag: rota.tag,
      },
    });
    try {
      const err = await rotateCipherKey(appDb, {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
        dryRun: false,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RotationAbortedError);
      const report = (err as RotationAbortedError).report;
      expect(report.unreadable).toEqual([
        { table: 'tenant_setting', id: rotaId, ref: `${tenantA}/zoom-live/credentials` },
      ]);
      // Ni un secreto en el informe.
      expect(JSON.stringify(report)).not.toContain('sk_de-A');
      // Las demás filas, que sí se habían recifrado dentro de la transacción,
      // vuelven a estar como estaban.
      await expectAllDecryptWith(OLD_KEY, NEW_KEY);
    } finally {
      await admin.tenantSetting.delete({ where: { id: rotaId } });
    }
  });

  it('rotación real: todo descifra con la clave nueva, nada con la vieja, y lo que estaba en claro no se toca', async () => {
    const report = await rotateCipherKey(appDb, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: false,
    });

    expect(report.committed).toBe(true);
    expect(report.unreadable).toEqual([]);
    await expectAllDecryptWith(NEW_KEY, OLD_KEY);

    const plain = await admin.tenantSetting.findUniqueOrThrow({ where: { id: ids.plainA } });
    expect(plain.valueJson).toEqual({ verifiedAt: '2026-11-12T00:00:00.000Z' });
    expect(plain.valueCipher).toBeNull();
  });

  it('repetirla no rompe nada: las filas ya rotadas se reconocen y no se tocan', async () => {
    const antes = await admin.tenantSetting.findUniqueOrThrow({ where: { id: ids.stripeA } });

    const report = await rotateCipherKey(appDb, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: false,
    });

    expect(report.committed).toBe(true);
    for (const table of ['tenant_setting', 'core_instance_setting', 'mod_secret']) {
      expect(report.tables[table]!.reencrypted, `${table}: nada que recifrar`).toBe(0);
      expect(report.tables[table]!.alreadyRotated).toBe(report.tables[table]!.total);
    }
    const despues = await admin.tenantSetting.findUniqueOrThrow({ where: { id: ids.stripeA } });
    expect(Buffer.from(despues.valueIv!).equals(Buffer.from(antes.valueIv!))).toBe(true);
    await expectAllDecryptWith(NEW_KEY, OLD_KEY);
  });

  it('con --skip-unreadable rota lo que puede y deja la fila rota como estaba', async () => {
    const rota = enc(OTHER_KEY, 'ilegible');
    const rotaId = randomUUID();
    await admin.modSecret.create({
      data: {
        id: rotaId,
        tenantId: tenantA,
        moduleId: 'mod.rotacion',
        secretKey: `rota-${stamp}`,
        ciphertext: rota.cipher,
        iv: rota.iv,
        tag: rota.tag,
        approxValueBytes: 8,
      },
    });
    try {
      // De vuelta a la clave original, conectando esta vez como administrador.
      const report = await rotateCipherKey(admin, {
        oldKey: NEW_KEY,
        newKey: OLD_KEY,
        dryRun: false,
        skipUnreadable: true,
      });

      expect(report.committed).toBe(true);
      expect(report.dbRole).not.toBe('didacta_super');
      expect(report.unreadable.map((u) => u.id)).toEqual([rotaId]);
      await expectAllDecryptWith(OLD_KEY, NEW_KEY);
      expect(await readSecret('mod_secret', rotaId, OTHER_KEY)).toBe('ilegible');
    } finally {
      await admin.modSecret.delete({ where: { id: rotaId } });
    }
  });

  it('rechaza claves mal formadas o iguales antes de abrir la transacción', async () => {
    await expect(
      rotateCipherKey(appDb, { oldKey: OLD_KEY, newKey: OLD_KEY, dryRun: true }),
    ).rejects.toThrow(/igual que la actual/);
    await expect(
      rotateCipherKey(appDb, { oldKey: OLD_KEY, newKey: 'corta', dryRun: true }),
    ).rejects.toThrow(/NUEVA/);
  });
});
