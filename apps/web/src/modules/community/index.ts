/// Extension point del módulo `mod.community` hacia el core.
///
/// El catálogo `apps/web/src/modules/index.ts` importa esta constante y la
/// agrega al `moduleExtensions[]`. Aporta los items de sidebar de
/// `/comunidad` y `/comunidad/menciones` (grupo Aprendizaje, visibles
/// para cualquier rol que vea el grupo).

import type { ModuleWebExtension } from '@/lib/module-registry';

export const communityExtension: ModuleWebExtension = {
  name: 'mod.community',
  sidebarItems: [
    {
      group: 'Aprendizaje',
      href: '/comunidad/menciones',
      label: 'Mis menciones',
      icon: 'message',
    },
  ],
};

export {
  communityApi,
  COMMUNITY_TAG_ICONS,
  COMMUNITY_SPACE_ICONS,
  type Post,
  type Comment,
  type Reaction,
  type PostDetail,
  type Broadcast,
  type PostSort,
  type CommunityTag,
  type CommunityTagIcon,
  type CommunitySpaceIcon,
  type CommunityAttachment,
} from './client';

export { useCommunityTags, invalidateCommunityTagsCache } from './tags-client';
export { useCommunitySpaces, invalidateCommunitySpacesCache } from './spaces-client';
export type { CommunitySpace } from './client';

export { parseBodyAttachments, buildBodyWithAttachments } from './attachments';
export type { AttachmentImage, AttachmentFile, ParsedBody } from './attachments';

export {
  filterGalleryAttachments,
  galleryAuthorOptions,
  DEFAULT_GALLERY_FILTERS,
  type GalleryFilters,
  type GalleryType,
  type GallerySort,
} from './gallery';
