/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Param,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { BUNNY_GUID_RE, BUNNY_LIBRARY_ID_RE } from './bunny-embed';
import {
  VideoForbiddenError,
  VideoPlaybackService,
  VideoRateLimitedError,
  type PlayUrl,
} from './video-playback.service';

@ApiTags('Video')
@ApiBearerAuth()
@Controller('video')
@UseGuards(JwtAuthGuard)
export class VideoController {
  constructor(private readonly playback: VideoPlaybackService) {}

  @Get('bunny/:libraryId/:guid/play-url')
  @ApiOperation({
    summary:
      'URL de reproducción de un vídeo de Bunny Stream. Si el tenant protege esa librería: firmada y con caducidad (30 min), 403 si el usuario no puede ver el vídeo y 429 si supera el tope de vídeos distintos por cuenta. Si no la protege: la URL de embed sin firmar.',
  })
  async playUrl(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('libraryId') libraryId: string,
    @Param('guid') guid: string,
  ): Promise<PlayUrl> {
    if (!user) throw new UnauthorizedException();
    if (!BUNNY_LIBRARY_ID_RE.test(libraryId) || !BUNNY_GUID_RE.test(guid)) {
      throw new BadRequestException({ message: 'Vídeo no válido.', code: 'VIDEO_BAD_REQUEST' });
    }
    try {
      return await this.playback.getPlayUrl(
        { tenantId: user.tenantId, userId: user.sub, roles: user.roles },
        libraryId,
        // Bunny firma sobre el GUID tal cual lo tiene (minúsculas).
        guid.toLowerCase(),
      );
    } catch (error) {
      if (error instanceof VideoForbiddenError) {
        throw new HttpException({ message: error.message, code: 'VIDEO_FORBIDDEN' }, 403);
      }
      if (error instanceof VideoRateLimitedError) {
        throw new HttpException(
          {
            message: error.message,
            code: 'VIDEO_RATE_LIMITED',
            window: error.window,
            retryAfterSeconds: error.retryAfterSeconds,
          },
          429,
        );
      }
      throw error;
    }
  }
}
