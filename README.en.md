# Didacta Community

> 📚 **The next-generation LMS. Fair-code, modular and Fundae-ready.**

[![Docker](https://img.shields.io/badge/ghcr-didacta--community-blue)](https://github.com/va360labs/didacta-io/pkgs/container/didacta-community)
[![License](https://img.shields.io/badge/license-Sustainable%20Use%201.0-orange)](LICENSE)
[![Versioning](https://img.shields.io/badge/versioning-SemVer-green)](https://semver.org)
![Stage](https://img.shields.io/badge/stage-beta-orange)
[![Web](https://img.shields.io/badge/web-didacta.io-black)](https://didacta.io)
[![Built by VA360 LABS](https://img.shields.io/badge/built%20by-VA360%20LABS-1f2937)](https://va360labs.com)

🌍 **English** · [Español](README.md)

Built and maintained by **[VA360 LABS S.L.](https://va360labs.com)**, the
project's original author.

## Links

|                                    |                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 🌐 **Product and pricing**         | [didacta.io](https://didacta.io) · [editions and pricing](https://didacta.io/en/pricing)          |
| 📚 **Documentation**               | [docs.didacta.io](https://docs.didacta.io) — install, upgrade, operate and versioning (es/en)     |
| 📦 **Official image**              | `ghcr.io/va360labs/didacta-community`                                                             |
| 📋 **Published versions**          | [Releases](https://github.com/va360labs/didacta-io/releases)                                      |
| ⚖️ **The licence, in plain words** | [didacta.io/en/license](https://didacta.io/en/license) · [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md) |
| 🏢 **Who builds it**               | [va360labs.com](https://va360labs.com)                                                            |

## Current status

🧪 **Public beta** (`0.1.0-beta.N`). The product matured between May and July 2026 serving a real
production deployment; since 31 July 2026 the repository is the whitelabel
product, and in August 2026 it entered public beta. Install, upgrade and
versioning guides live at [docs.didacta.io](https://docs.didacta.io); the
history of each version is in
[Releases](https://github.com/va360labs/didacta-io/releases).

Official image on the GitHub Container Registry:
`ghcr.io/va360labs/didacta-community`. **Public** — no `docker login` needed,
and it is the only up-to-date source. The [Docker Hub](https://hub.docker.com/r/didactaio/community)
mirror (`didactaio/community`) exists but is **out of date** (it stopped at
`0.0.1-alpha.86`): do not deploy from it.

## Check you can pull the image

```bash
# ALWAYS pin a specific version: moving tags (`beta`) are for test
# environments and `latest` will exist only for stable releases.
docker pull ghcr.io/va360labs/didacta-community:<version>
```

If it downloads without asking for credentials, you can follow any of the
deployment paths below.

## One-command install

The fast route. It needs **Docker** and the **Docker Compose v2** plugin (`docker compose`), nothing else.

```bash
curl -fsSL https://raw.githubusercontent.com/va360labs/didacta-io/main/install.sh | bash
```

The installer downloads the compose file, **generates your `AUTH_SECRET`**, pins the image version, brings the stack up, waits for it to respond, and finishes by printing **the setup wizard link with its token** — which is where everyone gets stuck the first time, since otherwise you have to dig it out of the logs.

It asks nothing and overwrites nothing: if a `.env` with `AUTH_SECRET` already exists it reuses it instead of regenerating it (regenerating would silently sign every user out).

Running a script from the internet sight unseen is a bad idea with any installer, so you can read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/va360labs/didacta-io/main/install.sh -o install.sh
less install.sh
bash install.sh
```

When it finishes you get a `didacta/` folder with `docker-compose.alpha.yml` and the generated `.env`. From there you operate it like any other compose install.

**Optional variables**, all with sensible defaults:

| Variable               | What it does                                        | Default          |
| ---------------------- | --------------------------------------------------- | ---------------- |
| `DIDACTA_DIR`          | Folder to install into                              | `didacta`        |
| `DIDACTA_IMAGE_TAG`    | Image version to deploy                             | the script's own |
| `WEB_PORT`             | Web port                                            | `3000`           |
| `API_PORT`             | API port                                            | `4000`           |
| `MAILPIT_UI_PORT`      | Mailpit port                                        | `8025`           |
| `DIDACTA_PROJECT`      | Compose project name, to coexist with another copy  | —                |
| `DIDACTA_COMPOSE_FILE` | Use a local compose file instead of downloading one | —                |

```bash
# Example: install into ./aula, with the web on port 8080
DIDACTA_DIR=aula WEB_PORT=8080 bash install.sh
```

If you would rather do it by hand, or already run managed Postgres and Redis, follow Path A or Path B.

## Self-hosting panels (Coolify, Dokploy, Easypanel)

If you already run your server through one of these panels, [`deploy/`](deploy/) ships a template per platform in each one's native format: they generate secrets with the panel's own helpers, expose **a single domain** (the web app rewrites `/api/*` to the internal API) and pin the `pgvector` Postgres image Didacta requires.

You can use them today by pasting them into your panel — no need to wait for the official catalogues. Per-platform details and caveats live in [`deploy/README.md`](deploy/README.md).

## Required environment variables

Only **3 environment variables** are strictly required to boot. The rest have
sensible defaults or are injected by the compose file. The complete set is
documented in [`.env.example`](.env.example).

| Variable       | What it is                                                             | How to generate it                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Postgres 16 connection string with the `pgvector` extension installed. | Point it at your Postgres. Format: `postgresql://<USER>:<PASSWORD>@<HOST>:5432/didacta?schema=public`. With this repo's compose it is built for you from `POSTGRES_USER` and `POSTGRES_PASSWORD`.                                                                                                                                                     |
| `REDIS_URL`    | Redis 7 connection string.                                             | Point it at your Redis. For compose: `redis://redis:6379`.                                                                                                                                                                                                                                                                                            |
| `AUTH_SECRET`  | Secret used to sign sessions and cookies. Minimum 32 characters.       | Any random string of **32+ characters** works: an online password generator set to 40+, your password manager's "generate password", `openssl rand -base64 32`, or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. What matters is that it is random and that you keep it. Change it and every session is invalidated. |

## Path A — Docker Compose

Recommended for most installations.

Stack: API + web + Postgres + Redis + Mailpit (SMTP). Local storage by default
in a Docker volume, no external S3 required.

```bash
# 1. Clone
git clone https://github.com/va360labs/didacta-io.git
cd didacta-io

# 2. Configure .env
cp .env.example .env

# 3. Put your AUTH_SECRET in .env — a random string of 32+ characters.
#    openssl rand -base64 32
#    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 4. Pin the image version (published ones are in Releases:
#    https://github.com/va360labs/didacta-io/releases)
echo "DIDACTA_IMAGE_TAG=<version>" >> .env

# 5. Start
docker compose -f docker-compose.alpha.yml up -d

# 6. Wait for the healthchecks (~60-90s the first time)
docker compose -f docker-compose.alpha.yml ps

# 7. Copy the single-use setup token (required to create the admin account —
#    without it /setup/init answers 403). It stops working as soon as the
#    wizard finishes or the container restarts without finishing it.
docker compose -f docker-compose.alpha.yml logs didacta | grep "Setup token"

# 8. Open (use the /setup?token=... URL printed by the previous step)
# http://localhost:3000             — Web
# http://localhost:4000/api/docs    — Swagger
# http://localhost:4000/healthz     — health probe
# http://localhost:8025             — Mailpit, test emails
```

### Persistence: Docker volumes

The compose file declares four named volumes that survive `down`/`up` and
restarts:

| Volume          | What it holds                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `postgres_data` | The whole database.                                                                                                             |
| `redis_data`    | Persistent queue (`appendonly yes`) — outbox + jobs.                                                                            |
| `didacta_data`  | The application's local storage: course uploads, certificates and evidence + the auto-generated key that encrypts data at rest. |
| `minio_data`    | Only if you enable the `s3` profile. Holds the MinIO buckets.                                                                   |

**Important**: `docker compose down -v` deletes the volumes and therefore the
data. To stop without deleting, use `docker compose down` without `-v`.

Recommended production backup: `pg_dump` plus a `tar` of the `didacta_data`
volume.

### Optional storage with MinIO

To try the S3-compatible flow without paying AWS, Hetzner or anyone else,
start MinIO with the `s3` profile:

```bash
docker compose -f docker-compose.alpha.yml --profile s3 up -d
# MinIO console at http://localhost:9001
```

Then uncomment the `S3_*` lines in `docker-compose.alpha.yml`, inside the
`didacta` service, so the application uses MinIO instead of local disk.

For real production, point at your Hetzner Object Storage, AWS S3 or any
compatible provider by setting the `S3_*` variables in `.env`.

This page covers getting started; the full install, upgrade and operations
manual lives at [docs.didacta.io](https://docs.didacta.io). For questions,
bugs or feedback, open a GitHub issue — there are bug, feedback and feature
request templates. For security vulnerabilities, follow
[`SECURITY.md`](SECURITY.md).

## Path B — Docker pull and run

For operators who already run managed Postgres 16 + Redis 7 and only want to
run the application container.

**Prerequisites:**

- Postgres 16 with the `pgvector` extension installed and an empty schema. The
  application applies the Prisma migrations at boot.
- Redis 7 reachable from the container.
- The 3 required environment variables listed above.

```bash
docker pull ghcr.io/va360labs/didacta-community:0.1.0-beta.8

# Volume for uploads plus the auto-generated encryption key.
# It survives restarts.
docker volume create didacta_data

docker run -d \
  --name didacta-app \
  -p 3000:3000 \
  -p 4000:4000 \
  -v didacta_data:/app/data \
  -e DATABASE_URL='postgresql://<USER>:<PASSWORD>@<HOST>:5432/didacta?schema=public' \
  -e REDIS_URL='redis://<HOST>:6379' \
  -e AUTH_SECRET='<your-random-string-of-32+-characters>' \
  -e STORAGE_DRIVER=local \
  -e STORAGE_ROOT=/app/data/storage \
  -e NODE_ENV=production \
  --restart unless-stopped \
  ghcr.io/va360labs/didacta-community:0.1.0-beta.8
```

> The `didacta_data` volume holds the uploaded files — courses, certificates
> and evidence — **and** an encryption key generated on first boot for
> at-rest secrets. Without that volume mounted, everything is lost when the
> container is recreated.

> If you prefer S3-compatible storage over local disk: drop `STORAGE_DRIVER`
> and `STORAGE_ROOT`, and add `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and
> `S3_SECRET_KEY`. Even then, keep the volume mounted for the encryption key.

**Verify:**

```bash
docker logs -f didacta-app                    # bootstrap + Prisma migrations
curl -fsS http://localhost:4000/healthz       # must answer 200
docker logs didacta-app | grep "Setup token"  # single-use token for /setup?token=...
```

**Useful optional variables** — the complete set is in
[`.env.example`](.env.example):

| Variable                                                        | What for                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`    | S3-compatible storage: MinIO, AWS, Hetzner and so on. Required for content uploads.            |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Transactional email. Without it, emails are logged but never sent.                             |
| `DIDACTA_LICENSE_KEY`                                           | JWT signed by Didacta that activates Enterprise capabilities. Without it, pure Community mode. |
| `METRICS_TOKEN`                                                 | Bearer token protecting `/metrics` for Prometheus. If empty, the endpoint is public.           |

## About the project

Didacta is a **next-generation fair-code LMS** (Learning Management System):
source available under the
[Didacta Sustainable Use License v1.0](LICENSE), modular architecture, no
per-user licences and legal compliance built into the core. Designed for
academies, trainers and organisations that want to run their own training
platform with full control.

It is built and maintained by
**[VA360 LABS S.L.](https://va360labs.com)**, the project's original author
and the trademark holder. The code belongs to whoever deploys it — audit it,
modify it, use it internally without asking — while the direction of the
project stays with the people who started it. That is what fair-code means.

More information and a live demo: [didacta.io](https://didacta.io).

### Why Didacta

- **Genuinely modular.** Install only what you need. Every feature is a clean
  module: no patches, no themes that break on every upgrade, no accumulated
  technical debt.
- **Fair-code.** Your platform, your code: audit it, modify it and deploy it
  with free internal use under the
  [Didacta Sustainable Use License v1.0](LICENSE). No per-user licences.
  Commercial distribution, SaaS or third-party white-label require an
  agreement (see [Licensing model](#licensing-model)).
- **Compliance taken seriously.** Fundae, GDPR and WCAG 2.2 AA built into the
  core, not bolted on with third-party plugins. Traceability, auditing and
  data export ready from day one.
- **Discreet AI.** Artificial intelligence that helps without interrupting: it
  drafts content, suggests learning paths and summarises activity.

### Three ways to fill your academy

The three paths coexist in the same installation and combine freely:

1. **You enrol them.** Invite students one by one or in bulk from the admin:
   you pick their access group when inviting, they get an email to create
   their password and land straight in their courses. From each student's
   record you manage their groups, enrolments and removals. Ideal for internal
   or subsidised training, and for in-person classes moved to a virtual
   classroom.

2. **You sell individual courses.** Publish a course, price it — with several
   purchase options if you want — and share your public catalogue at
   `/catalogo`. Visitors pay by card through Stripe without registering first:
   their account is created automatically with the email confirmed at payment
   and they are enrolled instantly. Refunds revoke access on their own.

3. **You sell memberships.** Create plans with the billing period (1–12
   months) and currency you want, with an optional trial. Your public sales
   page at `/unete` shows the real catalogue; on subscribing, the student gets
   access to every course in the group you define. If they stop paying, access
   is revoked automatically — without touching anything you granted by hand.

And if your community needs prior approval, enable **registration by
request**: configure the verifiers your case needs (email verification,
Telegram or none), review the evidence behind each request and approve or
reject with one click.

### Three editions, one product

| Edition                   | Who it is for                                                               | What it includes                                                                                            |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Community** (this repo) | Teams that deploy and operate it themselves.                                | The complete source code. An active contributor community.                                                  |
| **Cloud**                 | Anyone who wants to start in minutes, with no infrastructure.               | Hosting managed by [VA360 LABS](https://va360labs.com) with hands-off updates. **In preparation.**          |
| **Enterprise**            | Organisations needing an SLA, bespoke integrations and a certified partner. | Dedicated account manager, guided onboarding, integrations with existing systems, monitored infrastructure. |

Details and pricing: [didacta.io/en/pricing](https://didacta.io/en/pricing).

## Licensing model

Didacta is **fair-code**: source available, free internal business use,
commercial distribution and third-party SaaS under agreement. An Open-Core
model with protected Enterprise capabilities:

- **Repo and modules**: [Didacta Sustainable Use License v1.0](LICENSE)
  (fair-code, adapted from the n8n SUL). Allows free internal business use.
  Commercial distribution, SaaS or white-label requires an agreement with
  [VA360 LABS S.L.](https://va360labs.com)
- **Enterprise capabilities** (`*.ee.*` files inside the CORE):
  [Didacta Enterprise License](LICENSE_EE). They require an active signed
  licence to run in production.
- **Cloud**: SaaS managed by [VA360 LABS](https://va360labs.com). **In
  preparation**, not open yet.

Plain-language summary: [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md). Commercial
use policy: [`COMMERCIAL_USE.md`](COMMERCIAL_USE.md). Trademark:
[`TRADEMARKS.md`](TRADEMARKS.md). Licensing questions: `licensing@didacta.io`.

## Telemetry

Every installation sends **one anonymous daily heartbeat** to
`registry.didacta.io` so we know how many Didacta installations exist. This is
the entire payload, and nothing else:

| Field                 | Contents                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `instanceId`          | A **random** UUID generated on first run (`.didacta-instance-id` in the data volume). It identifies no person and no organisation. |
| `version` / `edition` | Didacta version and edition (`community` or the Enterprise plan).                                                                  |
| `node` / `os`         | Node version and platform (`linux/x64`…).                                                                                          |
| `sentAt`              | Heartbeat date.                                                                                                                    |

No PII, no business data (no users, no courses, no domains), and it blocks
nothing: with no internet access the heartbeat fails silently and the platform
works the same. **It is disabled with an environment variable**:

```bash
DIDACTA_TELEMETRY_DISABLED=true
```

Separately there is a voluntary **opt-in registry** (Administration →
Registry) where the operator can identify themselves with an email and
organisation in exchange for a direct channel to the team; that level sends
aggregated metrics and has opt-out and GDPR deletion from the panel itself.

## Documentation

- 📚 [docs.didacta.io](https://docs.didacta.io) — Official documentation
  (es/en): install, upgrade, operations and versioning.
- 🤝 [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution guide.
- 🔒 [`SECURITY.md`](SECURITY.md) — Security policy and responsible
  disclosure.
- 📋 [Releases](https://github.com/va360labs/didacta-io/releases) — Change
  history for each published version.
- 📜 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md) — Plain-language summary of the
  licensing model.
- 🧭 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Code of conduct.
- 🐛 Bugs and feedback — GitHub issues (bug, feedback and feature request
  templates).

## Tech stack

- **Backend**: Node.js 22 + NestJS 11 + TypeScript.
- **Frontend**: Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui.
- **Database**: PostgreSQL 16 with Row-Level Security + Prisma.
- **Cache and queues**: Redis 7 + BullMQ.
- **Object storage**: S3-compatible (MinIO in compose, any S3 provider in
  production).
- **AI**: pluggable layer — it currently uses an external LLM provider;
  future versions will allow switching providers.
- **Monorepo**: Turborepo + pnpm workspaces.

## Licence

Didacta Community © 2026 [VA360 LABS S.L.](https://va360labs.com) — the
project's original author. Distributed under the
[Didacta Sustainable Use License v1.0](LICENSE) (fair-code).

Enterprise capabilities: [Didacta Enterprise License](LICENSE_EE).

Didacta™ is a trademark of [VA360 LABS S.L.](https://va360labs.com) See
[`TRADEMARKS.md`](TRADEMARKS.md).
