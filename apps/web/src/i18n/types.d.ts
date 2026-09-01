/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Augment de next-intl: las keys de `useTranslations`/`getTranslations` se
 * tipan contra el catálogo español canónico. Cada JSON que llena una unidad
 * de trabajo amplía este tipo automáticamente.
 */

import type { SupportedLocale } from './config';
import type messages from './messages/es';

declare module 'next-intl' {
  interface AppConfig {
    Messages: typeof messages;
    Locale: SupportedLocale;
  }
}
