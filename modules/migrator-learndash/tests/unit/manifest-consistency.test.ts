import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifest as runtimeManifest } from '../../src/manifest.js';
import { routes } from '../../src/index.js';

/// Tests de consistencia del manifest del módulo (v1.0.31+).
///
/// Protegen contra el drift que llevó al bug del ping devolviendo
/// version "1.0.28" cuando el package.json y el git tag ya iban por 1.0.30:
/// había DOS fuentes de verdad (`src/manifest.ts` hardcoded y `package.json`)
/// y nada validaba que coincidieran.
///
/// A partir de 1.0.31, `src/manifest.ts` LEE `version` de `package.json`
/// (import directo, bundled por esbuild). Estos tests garantizan que:
///
///   1. La version del manifest runtime == package.json.version
///   2. El module.json (lo que se firma) tiene la misma version que package.json
///   3. El module.json viene ya en el SHAPE EXPANDIDO que el host valida
///      (vendor=didacta, permissions como objetos, surfaces como objeto, etc.).
///      Antes de 1.0.31 el module.json era "compacto" y requería transformación
///      manual antes de firmar, lo que provocó el bug MANIFEST_SCHEMA_INVALID
///      al re-instalar 1.0.30 en una instancia fresca.
///
/// Si en el futuro alguien rompe cualquiera de estos invariantes (ej. añade
/// version hardcoded en otro sitio, o convierte permissions a strings),
/// estos tests fallan ANTES del release, no en producción.

const REPO_ROOT = resolve(__dirname, '..', '..');

const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
const moduleJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'module.json'), 'utf8'));

describe('manifest consistency', () => {
  describe('version drift (single source = package.json)', () => {
    it('manifest runtime expone la version del package.json (no hardcoded)', () => {
      expect(runtimeManifest.version).toBe(pkg.version);
    });

    it('module.json (lo que se firma) tiene la misma version que package.json', () => {
      expect(moduleJson.version).toBe(pkg.version);
    });

    it('GET /ping devuelve la version del manifest (no un literal stale)', async () => {
      const route = routes.find((r) => r.method === 'GET' && r.path === '/ping');
      expect(route).toBeDefined();
      const res = await route!.handler({
        method: 'GET',
        path: '/ping',
        params: {},
        query: {},
        body: undefined,
        user: null,
      } as any);
      expect(res.status).toBe(200);
      const body = res.body as { ok: boolean; name: string; version: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe(pkg.version);
    });
  });

  describe('module.json shape expandido (el firmador ya no transforma)', () => {
    it('name sigue el regex del host: ^mod\\.<slug>$', () => {
      expect(moduleJson.name).toMatch(/^mod\.[a-z0-9][a-z0-9-]{0,40}$/);
      // Específicamente para este módulo:
      expect(moduleJson.name).toBe('mod.migrator-learndash');
    });

    it('vendor = didacta (requerido por el firmador KMS)', () => {
      expect(moduleJson.vendor).toBe('didacta');
    });

    it('permissions es array de objetos {name, description}', () => {
      expect(Array.isArray(moduleJson.permissions)).toBe(true);
      expect(moduleJson.permissions.length).toBeGreaterThan(0);
      for (const p of moduleJson.permissions) {
        expect(typeof p).toBe('object');
        expect(typeof p.name).toBe('string');
        // description es opcional pero, si está, debe ser string.
        if (p.description !== undefined) {
          expect(typeof p.description).toBe('string');
        }
      }
    });

    it('surfaces es objeto indexado por surface (no array)', () => {
      expect(typeof moduleJson.surfaces).toBe('object');
      expect(Array.isArray(moduleJson.surfaces)).toBe(false);
      // Para este módulo se espera al menos `admin`.
      expect(moduleJson.surfaces.admin).toBeDefined();
      expect(moduleJson.surfaces.admin.entry).toMatch(/dist\/ui\/.*\.js$/);
    });

    it('eventos van en eventsEmitted/eventsConsumed (no en "events")', () => {
      expect(Array.isArray(moduleJson.eventsEmitted)).toBe(true);
      expect(Array.isArray(moduleJson.eventsConsumed)).toBe(true);
      expect(moduleJson.events).toBeUndefined();
    });

    it('NO contiene keys legacy que el schema strict del host rechaza', () => {
      // edition, category, requiredLicenseFeature ya no existen en el
      // contrato actual del host (apps/api/src/marketplace/module-manifest.schema.ts).
      expect(moduleJson.edition).toBeUndefined();
      expect(moduleJson.category).toBeUndefined();
      expect(moduleJson.requiredLicenseFeature).toBeUndefined();
    });

    it('bloques de runtime presentes: http, didacta, jobLifecycle, requiresSecrets', () => {
      // El módulo necesita estos para que el host le inyecte los clientes
      // correctos (sandboxed http, ctx.didacta, worker BullMQ, secrets cifrados).
      // Si alguien borra uno por accidente, el módulo recibiría clientes
      // bloqueados y fallaría al primer uso. El test los obliga a estar.
      expect(moduleJson.http).toBeDefined();
      expect(moduleJson.didacta?.externalSource).toBe('learndash');
      expect(moduleJson.jobLifecycle?.onTickFn).toBe('onJobTick');
      expect(moduleJson.requiresSecrets).toBe(true);
      expect(moduleJson.requiresDb).toBe(true);
    });
  });
});
