export {
  moduleManifestSchema,
  moduleDependencySchema,
  roleDefinitionSchema,
  hookDefinitionSchema,
  uiExtensionSchema,
  pageDefinitionSchema,
  parseModuleManifest,
  ModuleManifestValidationError,
} from './module/manifest.js';

export type {
  ModuleManifest,
  ModuleDependency,
  RoleDefinition,
  HookDefinition,
  UIExtension,
  PageDefinition,
} from './module/manifest.js';

export type {
  LearnShipModule,
  ModuleContext,
  Logger,
  EventBus,
  DomainEvent,
  EventMetadata,
  HookRegistry,
  HookContext,
  StorageService,
  AuditLogService,
  EvidenceVaultService,
  NotificationHubService,
  I18nService,
  TenantConfigService,
} from './module/module.js';
