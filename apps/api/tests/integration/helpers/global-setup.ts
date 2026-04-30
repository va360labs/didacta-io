/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Vitest globalSetup wrapper — vitest exige un módulo con default export
 * que devuelva una función teardown (o async setup → función teardown).
 */

import { setup as setupFn, teardown as teardownFn } from './setup-db';

export default async function setup() {
  await setupFn();
  return async () => {
    await teardownFn();
  };
}
