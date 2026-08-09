/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Body HTTP de los errores de dominio de los módulos (`modules/<mod>/src/errors.ts`).
 *
 * Existe para que el campo `detail` llegue al front UNA vez y no veintitantas.
 * Los ~22 `ExceptionFilter` de `apps/api/src/**` componían el body a mano con
 * las mismas tres líneas (`statusCode` / `code` / `message`); añadir `detail`
 * ahí dentro habría sido el mismo cambio repetido 22 veces, y el 23º filtro
 * —el que se escriba mañana— se habría olvidado en silencio. Con este helper el
 * filtro nuevo lo hereda por construcción.
 *
 * El contrato `detail` está documentado en `apps/web/src/lib/api-client.ts`
 * (`ApiError.detail`) y en `apps/web/src/lib/i18n/api-error.ts`
 * (`CODES_WITH_DETAIL`): es el diagnóstico CRUDO de un sistema externo (el
 * mensaje de Stripe, la respuesta de Zoom, el error del proveedor de IA) que
 * viajaba INCRUSTADO en el `message` español. Al traducir el `message` por
 * `code`, el catálogo inglés lo sustituía por una frase genérica y el dato se
 * perdía. Como campo aparte, cada idioma escribe su propia frase e interpola
 * `{detail}`.
 *
 * El `message` NO cambia: sigue siendo la frase española completa, que es el
 * fallback honesto cuando el front no conoce el code.
 *
 * ── `params`: el mismo contrato cuando los valores son DOS o más ─────────────
 *
 * `detail` es un campo ÚNICO y sin nombre, y por eso no sirve para un `message`
 * que interpola varios valores CON COPY ESPAÑOL ENTRE MEDIAS
 * (`Provider ${provider} falló: ${reason}`). Colapsarlos en un solo `detail`
 * dejaría el conector español dentro de la frase inglesa —«The AI provider
 * failed: openai *falló*: timeout»—, que mueve el bug en vez de arreglarlo.
 *
 * `params` es la ampliación que los PR #39 y #42 dejaron declarada: un mapa
 * `nombre → valor` que cada catálogo interpola por nombre (`{provider}`,
 * `{reason}`), de modo que cada idioma coloca los valores donde su gramática
 * los pide y el ES sigue rindiendo byte a byte el `message` del backend.
 *
 * Los dos campos se EXCLUYEN por code (hay test): o el dato es uno y anónimo
 * (`detail`), o son varios y nombrados (`params`).
 */

/**
 * Lo mínimo que este helper necesita de una excepción de módulo. Es
 * ESTRUCTURAL a propósito: los 21 módulos declaran su propia clase base
 * (`BillingError`, `FundaeError`…) y ninguna comparte ancestro, así que un
 * `instanceof` obligaría a importar los 21 paquetes aquí.
 */
export interface ModuleDomainErrorLike {
  readonly code: string;
  readonly message: string;
  /** Diagnóstico crudo del sistema externo. Ausente si no hay ninguno. */
  readonly detail?: string;
  /**
   * Valores CON NOMBRE que el `message` español interpola en más de un hueco.
   * Ver `ModuleErrorBody.params`.
   */
  readonly params?: Readonly<Record<string, string>>;
}

export interface ModuleErrorBody {
  statusCode: number;
  code: string;
  message: string;
  detail?: string;
  params?: Record<string, string>;
  [extra: string]: unknown;
}

/**
 * CAMINO DEGRADADO NOMBRADO: un `detail` vacío o en blanco NO se emite.
 *
 * Mandarlo vacío sería peor que no mandarlo: el front vería el campo presente e
 * interpolaría la frase traducida con el hueco a cero («SMTP failed: »), que
 * promete un diagnóstico y no lo enseña. Omitiéndolo, `apiErrorMessage` degrada
 * al `message` crudo —español, pero completo—, que es la decisión ya tomada en
 * `lib/i18n/api-error.ts`.
 */
function presentDetail(detail: unknown): string | undefined {
  return typeof detail === 'string' && detail.trim() !== '' ? detail : undefined;
}

/**
 * MISMO camino degradado que `presentDetail`, aplicado al mapa completo: si
 * FALTA un solo valor, no se emite NINGUNO.
 *
 * Es deliberadamente todo-o-nada. Un `params` a medias haría que el front
 * pintase la frase traducida con un hueco vacío («The AI provider  failed:
 * timeout»), que es justo la promesa incumplida que este contrato existe para
 * evitar. Sin el campo, `apiErrorMessage` degrada al `message` crudo —español,
 * pero completo—, que es la decisión ya tomada para `detail`.
 */
function presentParams(params: unknown): Record<string, string> | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    out[key] = value;
  }
  return out;
}

/**
 * Body normalizado de un error de dominio de módulo.
 *
 * @param extra Campos propios de un filtro concreto (`reasons` de
 *   courses, `details` de marketplace / tenant-modules). Se mezclan al final
 *   para que un filtro pueda seguir añadiendo lo suyo sin duplicar el resto.
 */
export function moduleErrorBody(
  exception: ModuleDomainErrorLike,
  status: number,
  extra?: Record<string, unknown>,
): ModuleErrorBody {
  const detail = presentDetail(exception.detail);
  const params = presentParams(exception.params);
  return {
    statusCode: status,
    code: exception.code,
    message: exception.message,
    ...(detail === undefined ? {} : { detail }),
    ...(params === undefined ? {} : { params }),
    ...extra,
  };
}
