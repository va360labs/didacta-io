# Fixtures de licencias para tests de integración (MIG-034)

Las licencias **NO se persisten en disco**. Se generan en runtime al inicio de
la suite (`beforeAll`) usando un par de claves ES256 efímero que se inyecta
en la caché del verifier vía `registerPublicKeyForTest`.

## ¿Por qué no fixtures persistidas?

El verifier del SDK valida firma + iss + aud + exp. Para que un JWT persistido
verifique:

1. La pública debe estar registrada en `packages/license-sdk/src/public-keys/`,
   o…
2. Inyectarla en runtime ANTES de cada test (mismo flujo que el helper actual).

Persistir el JWT no aporta valor — la firma debe regenerarse cada arranque
porque las cachés de `jose` y la pareja efímera viven en memoria. Los tests
serían más frágiles (cualquier cambio en el schema rompería todos los JWT
guardados a disco).

## Cómo se generan las licencias

Ver [`apps/api/tests/integration/helpers/issue-test-license.ts`](../../helpers/issue-test-license.ts).

`issueCanonicalLicenses()` produce 4 tokens canónicos para los tests:

| Nombre                   | Capability         | exp      | Firma                   | Estado SDK esperado |
| ------------------------ | ------------------ | -------- | ----------------------- | ------------------- |
| `validWithWhiteLabel`    | `feat:white_label` | now+90d  | primary key             | `active`            |
| `validWithoutWhiteLabel` | `feat:scim`        | now+90d  | primary key             | `active` (sin WL)   |
| `expired`                | `feat:white_label` | now-100d | primary key             | `expired`           |
| `invalidSignature`       | `feat:white_label` | now+90d  | rogue key + kid primary | `invalid`           |

`primary key` = pareja generada en el primer call y registrada como kid
`didacta-test-2026` en el verifier.

## ¿Y si quiero persistir un JWT manualmente?

Generar uno suelto:

```ts
import { issueTestLicense } from '../helpers/issue-test-license';
const token = await issueTestLicense({
  capabilities: ['feat:white_label'],
  expiresAt: new Date('2030-01-01'),
});
console.log(token);
```

Pegar el token donde sea (logs, terminal, fixture .txt). Recordar:

- El token sólo verifica si `registerPublicKeyForTest` se ejecuta antes
  con la misma pareja primaria. La pareja primaria es **efímera** —
  cada arranque del proceso de test genera otra. Si querés un JWT que
  verifique cross-runs, tenés que persistir también la SPKI pública y
  registrarla manualmente.
- Los tests REALES de producción usan AWS KMS, no este helper.
