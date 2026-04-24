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
