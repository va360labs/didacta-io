# Política de versiones — Didacta

## Esquema

Didacta usa [SemVer](https://semver.org/) estricto para todas las versiones publicadas del host y los módulos del marketplace.

```
MAJOR.MINOR.PATCH[-PRERELEASE]
```

## Canales de publicación

| Canal | Formato de tag | Docker tag | Uso |
|-------|---------------|------------|-----|
| Alpha cerrada | `v0.0.1-alpha.N` | `0.0.1-alpha.N` | Testers internos bajo NDA |
| Beta pública | `v0.Y.0-beta.N` | `0.Y.0-beta.N` | Acceso anticipado |
| Release candidate | `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` | Candidatos a estable |
| Estable | `vX.Y.Z` | `X.Y.Z`, `latest` | General availability |

> `:latest` en Docker Hub NUNCA apunta a un pre-release.

## Ciclo actual — fase Alpha

El proyecto está en **fase 0 — Discovery técnico y fundaciones**. La versión del host sigue el esquema `0.0.1-alpha.N`, donde `N` se incrementa con cada entrega interna significativa.

### Reglas de bump en alpha

- `N` sube con cada PR merged que añade o cambia comportamiento observable.
- No hay MAJOR/MINOR bumps hasta alcanzar la primera beta.
- El CHANGELOG documenta cada alpha con el formato `[0.0.1-alpha.N]`.

## Versiones de módulos

Cada módulo del marketplace tiene su propio ciclo SemVer independiente del host.

### Campo `coreVersionRequired`

Todo `module.json` declara `coreVersionRequired` usando rangos SemVer compatibles con el resolver del host (`isCoreVersionCompatible` en `module-package.service.ts`):

| Operador | Significado |
|----------|-------------|
| `^X.Y.Z` | Compatible: mismo MAJOR, `>= X.Y.Z`. En 0.x.y el MINOR queda fijo. |
| `^0.0.1` | Cualquier `0.0.1-alpha.N` o `0.0.1` |
| `^0.0.1-alpha.81` | `0.0.1-alpha.81` o superior (mismo base) |
| `~X.Y.Z` | Patch-compatible: mismo MAJOR.MINOR, `>= X.Y.Z` |
| Versión exacta | Solo esa versión |

**Valor por defecto en módulos community:** `"^0.0.1"` (cualquier alpha/patch de la línea 0.0.1 y superior es válido).

## Release pipeline

1. El dev crea un tag `vX.Y.Z[-pre.N]` en `main`.
2. `release.yml` construye la imagen Docker multi-stage (api + web).
3. Publica en GHCR con los tags calculados.
4. `mirror-to-dockerhub.yml` (manual hasta MIG-053) espeja a Docker Hub.
5. `dev-deploy.yml` (push a rama `dev`) publica con tag `dev-<sha>` y dispara redeploy en Coolify (dev.didacta.io).

## Módulos del marketplace

Los módulos se versionan de forma independiente. Su pipeline de release (p. ej. `module-migrator-release.yml`) construye el bundle, firma con AWS KMS (`alias/didacta-issuer-2026`) y publica como GitHub Release con el ZIP firmado.

El host valida `coreVersionRequired` al instalar un módulo; si la versión del host no es compatible, rechaza la instalación con HTTP 422.
