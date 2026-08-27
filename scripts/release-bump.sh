#!/usr/bin/env bash
#
# Copyright (c) VA360 LABS S.L.
# SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
#
# Bump de versión para cortar release: pone la versión NUEVA en TODOS los
# sitios del repo que la llevan escrita, y falla si en alguno queda la vieja.
#
# Nació de dos fósiles reales: el README llevaba `alpha.107` en sus ejemplos
# de `docker pull` mientras el resto del repo iba por la 114 (el ritual de
# bump era un sed a mano sobre 10 ficheros y el README no estaba en la lista),
# y release.yml ahora ABORTA si el tag no coincide con package.json — este
# script es la otra mitad de esa guarda.
#
# Uso (desde la raíz del repo) — <V> es la versión nueva, sin 'v'. El ejemplo
# es un placeholder A PROPÓSITO: con una versión real, la verificación de
# fósiles de este mismo script se caza a sí misma en cuanto esa versión pasa
# a ser la vieja (pasó cortando la beta.3).
#   bash scripts/release-bump.sh <V>
#   git add -A && git commit -m "chore(release): <V>"
#   git tag v<V> && git push origin develop v<V>
set -euo pipefail

NEW="${1:?uso: release-bump.sh <version-nueva, sin 'v'>}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] ||
  { echo "ERROR: '$NEW' no es una versión válida (X.Y.Z[-canal.N])" >&2; exit 1; }

OLD="$(node -p "require('./package.json').version")"
[[ "$OLD" != "$NEW" ]] || { echo "Ya estamos en $NEW; nada que hacer."; exit 0; }

# La lista CERRADA de ficheros que llevan la versión escrita. Si añades uno,
# añádelo aquí: la verificación de abajo es la que impide que se fosilice.
FILES=(
  .github/ISSUE_TEMPLATE/bug.yml
  README.md
  README.en.md
  deploy/coolify/docker-compose.yaml
  deploy/dokploy/docker-compose.yml
  deploy/dokploy/meta.json
  deploy/dokploy/template.toml
  deploy/easypanel/didacta.json
  deploy/easypanel/meta.yaml
  docker-compose.alpha.yml
  install.sh
  package.json
)

echo "Bump ${OLD} → ${NEW}"
ESCAPED_OLD="${OLD//./\\.}"
for f in "${FILES[@]}"; do
  if grep -q "$ESCAPED_OLD" "$f"; then
    sed -i "s/${ESCAPED_OLD}/${NEW}/g" "$f"
    echo "  · $f"
  fi
done

# Ningún fichero versionado puede quedarse con la versión vieja — tampoco los
# que NO están en la lista (así se detecta un sitio nuevo que alguien añadió).
#
# `SECURITY-CREDITS.md` queda fuera porque ahí la versión NO es la que se
# publica, es la **afectada** por un hallazgo: un hecho histórico que no se mueve
# con el bump. Subirla convertiría el registro en falso y, de paso, atribuiría a
# la versión parcheada una vulnerabilidad que no tiene. Es la única excepción de
# este tipo: los tests de regresión de seguridad NO citan la versión, apuntan a
# este fichero, para que el dato viva en un solo sitio.
LEFTOVERS="$(git grep -l "$OLD" -- ':!pnpm-lock.yaml' ':!CHANGELOG.md' ':!SECURITY-CREDITS.md' || true)"
if [[ -n "$LEFTOVERS" ]]; then
  echo "ERROR: la versión vieja ${OLD} sigue apareciendo en:" >&2
  echo "$LEFTOVERS" >&2
  exit 1
fi

# ...y además TODOS los de la lista tienen que llevar ya la NUEVA.
#
# Esto no es redundante con la comprobación de arriba, es la mitad que faltaba:
# aquella solo busca la versión VIEJA, así que un fichero que se quedó atrás en
# un bump anterior es invisible para siempre. Con OLD=beta.5, un fichero
# fosilizado en beta.4 no contiene beta.5 (el sed no lo toca), no contiene
# beta.5 (la comprobación no lo ve) y se queda en beta.4 release tras release.
# Pasó de verdad: cortando la beta.6, `deploy/coolify/docker-compose.yaml`,
# `deploy/dokploy/template.toml` y `deploy/easypanel/meta.yaml` llevaban dos
# releases anunciando una imagen vieja, y las plantillas de PaaS son
# justamente lo que instala gente de fuera.
MISSING=()
for f in "${FILES[@]}"; do
  grep -q "$NEW" "$f" || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: estos ficheros de la lista NO llevan la versión nueva ${NEW}:" >&2
  printf '  · %s
' "${MISSING[@]}" >&2
  echo "Si alguno se quedó fosilizado en una versión anterior, ponlo a mano." >&2
  exit 1
fi

echo "Hecho. Revisa el diff, commitea 'chore(release): ${NEW}' y tagea v${NEW}."
