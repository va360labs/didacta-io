# Política de versionado — Didacta Community

> Esquema oficial de numeración de versiones para todos los componentes que se distribuyen desde este repo. Documento maestro completo en `arquitectura-didacta/13-VERSIONADO.md`. Aquí el resumen práctico.

## Esquema rápido

| Componente | Esquema | Ejemplo |
|------------|---------|---------|
| **Repo + imagen Docker** `didacta-community` | SemVer | `0.0.1-alpha.0`, `1.0.0` |
| **`@didacta/license-sdk`** | SemVer | `0.1.0` |
| **`@didacta/core-kernel`** | SemVer estricto | `1.0.0` (breaking = major) |
| **`@didacta/mod-*`** (futuro marketplace) | SemVer cada uno | `mod.courses@1.4.0` |
| **Cloud** (`didacta-cloud`, externo) | CalVer | `2026.04.0` |

## Pre-releases

```
0.0.1-alpha.0    # alpha cerrada, inestable
0.0.1-alpha.1    # bugfix dentro del mismo milestone
0.0.2-alpha.0    # nuevo milestone alpha
0.1.0-beta.0     # primera beta abierta
1.0.0-rc.0       # release candidate
1.0.0            # primer estable público
```

## Tags git

Siempre con prefijo `v`:

```bash
git tag v0.0.1-alpha.0
git push origin v0.0.1-alpha.0
```

## Imágenes Docker

```
ghcr.io/va360labs/didacta-community:0.0.1-alpha.0   # exacto
ghcr.io/va360labs/didacta-community:0.0.1-alpha     # último alpha de 0.0.1
ghcr.io/va360labs/didacta-community:alpha           # último alpha global
ghcr.io/va360labs/didacta-community:beta            # último beta global
ghcr.io/va360labs/didacta-community:latest          # último estable (NO pre-release)
```

⚠️ **`:latest` jamás apunta a un alpha o beta**. Antes de `1.0.0`, `:latest` simplemente no existe.

## Cuando hacer bump

### Pre-1.0.0

- **Patch** (`0.0.X` → `0.0.X+1`): bugfix dentro del mismo milestone alpha/beta.
- **Minor** (`0.0.X` → `0.1.0`): nuevo milestone con features significativas.
- **Major** (`0.X.Y` → `1.0.0`): primer release público estable.

### Post-1.0.0

- **Patch**: bugfix sin afectar API pública.
- **Minor**: feature retrocompatible.
- **Major**: breaking change en core-kernel / schema / API pública. **Exige ADR + migration guide en `docs/migrations/`.**

## Compatibilidad

### License SDK con apps

Cada app declara en su `package.json`:

```json
"dependencies": { "@didacta/license-sdk": "workspace:*" }
```

### Core-kernel con módulos

Cada `module.json` declara:

```json
{ "coreVersionRequired": "^1.0.0" }
```

`@didacta/core-registry` valida al boot. Si hay incompatibilidad, falla con `CoreVersionMismatchError`.

## Release notes

Cada tag publica release notes en GitHub con secciones:

```
🚨 Breaking changes
✨ Features
🐛 Bug fixes
🔧 Internal
📚 Migration guide  (si hay breaking)
```

Para pre-releases añadir disclaimer "ALPHA / BETA — uso bajo NDA / con precaución".

## Versión actual

- **Próximo tag a publicar**: `v0.0.1-alpha.0` (Sprint 1, MIG-038).
- Tag previo: ninguno.

## Documentación maestra

Ver `arquitectura-didacta/13-VERSIONADO.md` para el detalle completo (cadencia, criterios para 1.0.0, anti-patrones, decisiones pendientes).
