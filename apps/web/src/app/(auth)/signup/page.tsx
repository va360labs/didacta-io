/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { redirect } from 'next/navigation';

/**
 * El registro público está CERRADO: las altas entran por invitación de admin,
 * SSO o los módulos y APIs de registro instalados. La ruta se mantiene solo
 * para que los enlaces antiguos a /signup no den 404: redirigen al login. El
 * endpoint del API está igualmente cerrado (AUTH_SIGNUP_ENABLED, apagado por
 * defecto).
 */
export default function SignUpPage() {
  redirect('/signin');
}
