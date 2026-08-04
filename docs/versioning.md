# Política de versiones — Didacta

## Esquema

Didacta usa [SemVer](https://semver.org/) estricto para todas las versiones publicadas del host y los módulos del marketplace.

```
MAJOR.MINOR.PATCH[-PRERELEASE]
```

## Canales de publicación

| Canal | Formato de tag | Docker tag | Uso |
|-------|---------------|------------|-----|
| Alpha | `v0.0.1-alpha.N` | `0.0.1-alpha.N`, `0.0.1-alpha`, `alpha` | Self-hosters early adopters, sin garantías de estabilidad |
| Beta | `v0.Y.0-beta.N` | `0.Y.0-beta.N`, `0.Y.0-beta`, `beta` | Acceso anticipado |
| Release candidate | `vX.Y.Z-rc.N` | `X.Y.Z-rc.N`, `X.Y.Z-rc`, `rc` | Candidatos a estable |
| Estable | `vX.Y.Z` | `X.Y.Z`, `X.Y`, `X`, `latest` | General availability |

> `:latest` NUNCA apunta a un pre-release. Antes de `1.0.0` ese tag no existe.

El cómputo de tags Docker por canal vive en
[`.github/workflows/release.yml`](../.github/workflows/release.yml) — es la
fuente de verdad si este documento y el workflow llegan a desalinearse.

## Fase alpha

El host sigue el esquema `0.0.1-alpha.N`: `N` sube con cada release que añade
o cambia comportamiento observable. No hay bumps de MAJOR/MINOR hasta la
primera beta pública. Cada alpha se documenta en `CHANGELOG.md`.

## Versiones de módulos

Cada módulo del marketplace tiene su propio ciclo SemVer, independiente del
host.

### Campo `coreVersionRequired`

Todo `module.json` declara `coreVersionRequired` usando rangos SemVer
compatibles con el resolver del host (`isCoreVersionCompatible` en
`apps/api/src/marketplace/module-package.service.ts`):

| Operador | Significado |
|----------|-------------|
| `^X.Y.Z` | Compatible: mismo MAJOR, `>= X.Y.Z`. En `0.x.y` el MINOR queda fijo. |
| `^0.0.1` | Cualquier `0.0.1-alpha.N` o `0.0.1` |
| `^0.0.1-alpha.81` | `0.0.1-alpha.81` o superior (misma base) |
| `~X.Y.Z` | Patch-compatible: mismo MAJOR.MINOR, `>= X.Y.Z` |
| Versión exacta | Solo esa versión |

**Valor por defecto en módulos community:** `"^0.0.1"` (cualquier alpha/patch
de la línea `0.0.1` en adelante es válido).

Si la versión del host no es compatible, la instalación del módulo se
rechaza con `412 Precondition Failed` (`CORE_VERSION_INCOMPATIBLE`).

## Release pipeline (host)

1. Se crea un tag `vX.Y.Z[-pre.N]` sobre `main` (o se dispara `release.yml`
   manualmente vía `workflow_dispatch` con el tag deseado).
2. `release.yml` construye la imagen Docker (API + web en una sola imagen
   multi-stage) y la publica en GHCR
   (`ghcr.io/va360labs/didacta-community`) con los tags del canal
   correspondiente.
3. `release.yml` crea el GitHub Release con notas autogeneradas.
4. `mirror-to-dockerhub.yml` espeja la imagen a Docker Hub
   (`docker.io/didactaio/community`, imagen oficial pública). Hoy es un paso
   manual: se dispara con `workflow_dispatch` indicando el tag a copiar.

Para los pasos operativos de actualizar una instalación existente (backup,
pull, rollback), ver [`docs/UPGRADE.md`](UPGRADE.md).

## Módulos del marketplace

Los módulos first-party se versionan y publican con su propio pipeline. Por
ejemplo, `module-migrator-release.yml` construye el bundle de
`mod.migrator-learndash`, firma el manifest con AWS KMS
(`alias/didacta-issuer-2026`) y publica el ZIP firmado como GitHub Release,
disparado por tags con el prefijo del módulo (`mod.migrator-learndash-v*`).
