/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';

/// Proxy server-side al endpoint de tags de Docker Hub para
/// `didactaio/community`. Existe porque Docker Hub NO sirve los headers
/// CORS necesarios para que el browser haga el fetch directo. Lo
/// hacemos desde el server: same-origin para el frontend, sin
/// preflight, sin rate limit por user (cache compartido en memoria).
///
/// Cache TTL = 4h. Un solo fetch a Docker Hub atiende a todos los
/// browsers que peguen al endpoint en esa ventana. Si Docker Hub falla,
/// devolvemos `tags: []` y el frontend no muestra banner.

const DOCKERHUB_API =
  'https://hub.docker.com/v2/repositories/didactaio/community/tags?ordering=last_updated&page_size=25';
/// 15 minutos. Alpha sale a cadencia alta — TTL largo (4h del prototipo
/// inicial) tapaba publicaciones recientes y el banner no aparecía.
/// 15min × 24h = 96 reqs/día por instancia, dentro del rate limit de
/// Docker Hub anónimo (100 req/6h por IP).
const CACHE_TTL_MS = 15 * 60 * 1000;

interface DockerHubTagsResponse {
  results: Array<{ name: string; last_updated: string }>;
}

interface CachedResult {
  tags: Array<{ name: string; lastUpdated: string }>;
  fetchedAt: number;
}

@ApiTags('System')
@Controller('system')
export class VersionCheckController {
  private readonly logger = new Logger(VersionCheckController.name);
  private cache: CachedResult | null = null;
  private inflight: Promise<CachedResult> | null = null;

  @Get('version-check')
  @Public()
  @ApiOperation({
    summary:
      'Lista las versiones publicadas en Docker Hub para el footer de "versión nueva" del sidebar. Cache server-side 4h.',
  })
  async versionCheck(): Promise<{ tags: Array<{ name: string; lastUpdated: string }> }> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return { tags: this.cache.tags };
    }
    if (this.inflight) {
      const result = await this.inflight;
      return { tags: result.tags };
    }
    this.inflight = this.fetchAndCache();
    try {
      const result = await this.inflight;
      return { tags: result.tags };
    } finally {
      this.inflight = null;
    }
  }

  private async fetchAndCache(): Promise<CachedResult> {
    try {
      const res = await fetch(DOCKERHUB_API, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.logger.warn(`Docker Hub HTTP ${res.status} — devolviendo cache previa o lista vacía.`);
        return this.cache ?? { tags: [], fetchedAt: Date.now() };
      }
      const data = (await res.json()) as DockerHubTagsResponse;
      const tags = (data.results ?? []).map((t) => ({
        name: t.name,
        lastUpdated: t.last_updated,
      }));
      this.cache = { tags, fetchedAt: Date.now() };
      return this.cache;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Docker Hub fetch falló (${msg}) — devolviendo cache previa o lista vacía.`);
      return this.cache ?? { tags: [], fetchedAt: Date.now() };
    }
  }
}
