/// Versión del producto, hard-coded.
///
/// **NO usar `process.env.NEXT_PUBLIC_VERSION`** ni leer del package.json:
/// la versión se cambia ACÁ a mano cuando hacemos un release. Es la fuente
/// de verdad para:
///   - Pie del sidebar.
///   - Banner "hay una versión nueva" cuando lo implementemos (compara
///     contra el `latest` reportado por un endpoint del API o un canal
///     externo — ver propuesta en el chat).
///   - Tag de Docker Hub al hacer release (sed en el pipeline o manual
///     con cariño).
///
/// Cuando se publica un alpha nuevo, ACTUALIZAR esta constante ANTES
/// del build — sin esto el sidebar muestra una versión obsoleta tras
/// el deploy.
export const APP_VERSION = '0.0.1-alpha.55';

/// Canal de release. `alpha` = inestable, alta cadencia. Cuando hagamos
/// `beta`/`stable` añadir como literal type para que el banner del
/// sidebar pueda usarlo de pista visual.
export const APP_CHANNEL: 'alpha' | 'beta' | 'stable' = 'alpha';
