/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  DidactaModule,
  ModuleContext,
  Logger,
  EventBus,
  DomainEvent,
  EventMetadata,
  HookRegistry,
  HookContext,
  StorageAdapter,
  StorageService,
  UploadImageOptions,
  UploadedImage,
  AuditLogService,
  EvidenceVaultService,
  NotificationHubService,
  NotificationCategory,
  NotificationTerm,
  NotificationValue,
  I18nService,
  TenantConfigService,
} from './module/module.js';

export {
  sanitizeRichText,
  sanitizeLessonHtml,
  sanitizeLessonContent,
  sanitizeExternalUrl,
  RICH_TEXT_ALLOWED_TAGS,
  LESSON_ALLOWED_IFRAME_HOSTNAMES,
} from './html/sanitize.js';

export type { SanitizeHtmlOptions } from './html/sanitize.js';
