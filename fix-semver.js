const fs = require('fs');
const path = 'apps/api/src/marketplace/module-package.service.ts';
let content = fs.readFileSync(path, 'utf8');

// Find the start of isCoreVersionCompatible function and replace everything after
const marker = '/// Resolver de `coreVersionRequired`';
const idx = content.indexOf(marker);
if (idx === -1) {
  console.error('Marker not found');
  process.exit(1);
}

const newCode = `/// Resolver de \`coreVersionRequired\` (rango SemVer) contra la versión actual
/// de la instancia. Implementación mínima: soporta \`^X.Y.Z[-prerelease]\`,
/// \`~X.Y.Z[-prerelease]\` y versión exacta con pre-releases opcionales.
/// Cualquier otro operador (\`>=\`, ranges con AND) se trata como restrictivo
/// para no admitir un módulo que no podemos validar.
///
/// MOTIVACIÓN de no usar \`semver\` aquí: añadir una dep para tres reglas
/// concretas no compensa. Si la lógica crece, swap a \`semver\` es trivial.
///
/// PRE-RELEASE SUPPORT (alpha.X, beta.X, rc.X):
/// - \`^0.0.1-alpha.0\` matchea \`0.0.1-alpha.41\` (same base, prerelease >= required)
/// - \`^0.0.1\` matchea \`0.0.1-alpha.41\` (base version compatible, prerelease ignored)
export function isCoreVersionCompatible(required: string, actual: string): boolean {
  const r = required.trim();
  const a = actual.trim();

  // Regex con soporte para pre-release opcional: X.Y.Z o X.Y.Z-prerelease
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
  const caretSemver = /^\^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
  const tildeSemver = /^~(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

  const actualParsed = a.match(semver);
  if (!actualParsed) return false;
  const [, aMajorStr, aMinorStr, aPatchStr, aPrerelease] = actualParsed;
  const aMajor = Number(aMajorStr);
  const aMinor = Number(aMinorStr);
  const aPatch = Number(aPatchStr);

  // Exact match (sin operador): debe coincidir completamente
  const exactMatch = r.match(semver);
  if (exactMatch && !r.startsWith('^') && !r.startsWith('~')) {
    return r === a;
  }

  // Caret (^): mismo major, minor+patch >= required
  const caretMatch = r.match(caretSemver);
  if (caretMatch) {
    const [, rMajorStr, rMinorStr, rPatchStr, rPrerelease] = caretMatch;
    const rMajor = Number(rMajorStr);
    const rMinor = Number(rMinorStr);
    const rPatch = Number(rPatchStr);

    if (aMajor !== rMajor) return false;
    if (aMinor < rMinor) return false;
    if (aMinor === rMinor && aPatch < rPatch) return false;

    // Si base versions iguales y ambos tienen prerelease, comparar prereleases
    if (aMinor === rMinor && aPatch === rPatch && rPrerelease && aPrerelease) {
      return comparePrerelease(aPrerelease, rPrerelease) >= 0;
    }

    return true;
  }

  // Tilde (~): mismo major+minor, patch >= required
  const tildeMatch = r.match(tildeSemver);
  if (tildeMatch) {
    const [, rMajorStr, rMinorStr, rPatchStr, rPrerelease] = tildeMatch;
    const rMajor = Number(rMajorStr);
    const rMinor = Number(rMinorStr);
    const rPatch = Number(rPatchStr);

    if (aMajor !== rMajor) return false;
    if (aMinor !== rMinor) return false;
    if (aPatch < rPatch) return false;

    // Misma lógica de prerelease que caret
    if (aPatch === rPatch && rPrerelease && aPrerelease) {
      return comparePrerelease(aPrerelease, rPrerelease) >= 0;
    }

    return true;
  }

  return false;
}

/// Compara identificadores de prerelease: alpha.0 vs alpha.41
/// Retorna: negativo si a < b, 0 si iguales, positivo si a > b
/// Sigue SemVer spec: partes numéricas se comparan como números,
/// alfanuméricas como strings, numeric < alphanumeric.
function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    // Parte faltante es menor (menos partes = versión menor)
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNum = parseInt(aPart, 10);
    const bNum = parseInt(bPart, 10);
    const aIsNum = !isNaN(aNum) && String(aNum) === aPart;
    const bIsNum = !isNaN(bNum) && String(bNum) === bPart;

    // Ambos numéricos: comparar como números
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum;
      continue;
    }

    // Numérico < alfanumérico (SemVer spec)
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;

    // Ambos alfanuméricos: comparar como strings
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }

  return 0;
}
`;

content = content.substring(0, idx) + newCode;
fs.writeFileSync(path, content);
console.log('File updated successfully');
