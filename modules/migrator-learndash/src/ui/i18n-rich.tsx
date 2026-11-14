/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Textos con etiquetas (`<b>`, `<strong>`, `<code>`) del diccionario del
/// módulo, ya convertidos en elementos de React. Va aparte de `i18n.ts` porque
/// necesita el React del host (`_runtime`) y `i18n.ts` tiene que poder cargarse
/// en los tests sin `window.__didacta__`.

import { React } from './_runtime';
import { tParts, type MessageKey, type MessageVars } from './i18n';

export function tRich(key: MessageKey, vars?: MessageVars): React.ReactNode[] {
  return tParts(key, vars).map((part, i) =>
    typeof part === 'string' ? part : React.createElement(part.tag, { key: i }, part.text),
  );
}
