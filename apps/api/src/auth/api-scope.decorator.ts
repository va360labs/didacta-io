/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { SetMetadata } from '@nestjs/common';

export const API_SCOPES_KEY = 'requiredApiScopes';

/**
 * Declara los scopes que una API key debe tener para invocar el endpoint.
 * Se evalúa con `ApiScopeGuard`, que debe ir DESPUÉS de `JwtOrApiKeyGuard`
 * (el guard de auth popula `request.user.roles` con los scopes de la key).
 *
 * Ej: `@RequireApiScopes('enrollments:write')`.
 */
export const RequireApiScopes = (...scopes: string[]) => SetMetadata(API_SCOPES_KEY, scopes);
