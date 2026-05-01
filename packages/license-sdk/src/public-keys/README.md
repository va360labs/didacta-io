# Didacta License SDK — Public keys

This directory contains the **public keys** used by the License SDK to verify JWT licenses signed by VA360 LABS S.L.

## Key files

| File                                             | KID                            | Algorithm             | Storage of private key                            |    In use     |
| ------------------------------------------------ | ------------------------------ | --------------------- | ------------------------------------------------- | :-----------: |
| `didacta-issuer-2026.pem`                        | `didacta-issuer-2026`          | ECDSA P-256 (`ES256`) | AWS KMS `alias/didacta-issuer-2026` (eu-west-1)   |  ✅ current   |
| `didacta-issuer-2026-ed25519-DEPRECATED.pem.txt` | `didacta-issuer-2026` (legacy) | Ed25519 (`EdDSA`)     | Was in password manager, never used in production | ❌ deprecated |

> **Nota histórica**: el 2026-04-29 se generó inicialmente una pareja Ed25519 local como puente. Ese mismo día se decidió ir por **AWS KMS Camino A** (clave generada **dentro** del HSM, nunca tocó disco). La P-256 sustituyó a la Ed25519 antes de implementar el SDK, así que la Ed25519 nunca firmó ninguna licencia productiva.

## These are NOT secrets

Public keys are designed to be public. They allow ANYONE to **verify** a license signature, but NOT to **forge** one. Only the corresponding private key — generated and held inside AWS KMS HSM — can sign new licenses.

## How verification works

When a license is loaded:

1. The SDK parses the JWT header, extracts the `kid`.
2. It looks up the corresponding `*.pem` file in this directory.
3. It verifies the signature using the `jose` library with `ES256` (ECDSA P-256 + SHA-256).
4. It validates `iss=didacta.io`, `aud=didacta-runtime`, `exp`, `nbf`.
5. It returns the parsed payload to the rest of the runtime.

## How signing works (in `apps/license-issuer` — separate repo)

1. Service receives a request to issue a license (with valid auth).
2. It builds the JWT payload (license metadata).
3. It calls `aws kms sign --key-id alias/didacta-issuer-2026 --signing-algorithm ECDSA_SHA_256` with the JWT signing input (header + payload).
4. KMS returns the signature bytes; the service assembles the final JWT.
5. The private key never leaves KMS during this process. Only `kms:Sign` permission is required.

## Key rotation

Every ~2 years (or immediately on suspected compromise), we generate a new keypair with a new `kid`:

1. New private key generated in KMS.
2. New public key added to this directory under `didacta-issuer-<year>.pem`.
3. Old public key remains in this directory **for the lifetime of any license signed with the old key** (typically 1-2 more years).
4. Issuer starts signing new licenses with the new `kid` by default.

This allows seamless rotation: existing licenses keep working until their natural expiration.

## Compromise procedure

If a private key is compromised:

1. Mark the corresponding KID as **revoked** in the SDK source code.
2. Publish a security advisory.
3. Reissue all active licenses signed with the compromised KID using the new key.
4. Eventually remove the old public key (with a transition period).

## Why Ed25519?

- Modern asymmetric signature scheme (RFC 8032).
- Short signatures (~64 bytes) — JWT remains compact.
- Fast verification on resource-constrained instances.
- Well-supported by `jose`, native `crypto`, and most KMS providers.

## Curiosity: how to inspect a key

```bash
openssl pkey -in didacta-issuer-2026.pem -pubin -text -noout
```

Output should be `Public-Key: (256 bit)` Ed25519.
