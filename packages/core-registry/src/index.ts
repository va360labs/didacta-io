/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

export {
  ModuleRegistry,
  CoreVersionMismatchError,
  type ModuleRegistryOptions,
} from './module-registry.js';

export {
  resolveDependencyOrder,
  CircularDependencyError,
  MissingDependencyError,
  DependencyVersionMismatchError,
} from './dependency-resolver.js';
