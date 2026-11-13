/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Copy y cifras del panel de marca de las pantallas de acceso (/signin y
 * hermanas), para un visitante SIN sesión.
 *
 * Todo lo que se pinta ahí sale de aquí y es REAL:
 *  - `headline` / `subheadline`: copy que el admin escribe en /admin/branding
 *    (mod.theming). NULL = el web usa su copy genérico de Didacta. Nunca se
 *    inventa una frase por tenant.
 *  - `stats`: dos COUNT sobre la BD del tenant (miembros activos y cursos
 *    publicados). Si un contador sale 0, el web no pinta ese dato en vez de
 *    enseñar un número de cartón.
 *
 * Lectura cross-module (`mod_theming_tenant_theme`, `mod_courses_course`) desde
 * el core, siempre filtrada por `tenant_id` y solo de LECTURA — permitido para
 * core first-party por ADR-016. Mismo patrón que
 * `PasswordResetService.resolveTenantLogoUrl`, que ya lee el theme para los
 * emails de reset.
 */
export interface SigninBrandingStats {
  /**
   * Alumnos: usuarios ACTIVE no borrados del tenant SIN rol de equipo. El
   * panel dice «alumnos activos»: contar al creador o a los formadores hacía
   * que un aula recién creada presumiera de «1 alumno activo» sin tener ninguno.
   */
  activeMembers: number;
  /** Cursos PUBLISHED no borrados del tenant. */
  publishedCourses: number;
}

export interface SigninBrandingContext {
  headline: string | null;
  subheadline: string | null;
  /**
   * Color de marca del tenant (mod.theming). Las pantallas de acceso no tienen
   * sesión, así que el `TenantThemeProvider` no puede pedir el theme: sin esto
   * el login de cualquier tenant se pintaba con el azul default de Didacta.
   */
  brandHue: number;
  brandSaturation: number;
  /**
   * Cómo se presenta la marca: 'logo_only' (el logo sustituye al nombre, a su
   * ancho natural) o 'logo_and_name' (logo compacto + nombre). Lo elige el
   * admin en mod.theming; las pantallas sin sesión lo necesitan aquí.
   */
  logoDisplayMode: 'logo_only' | 'logo_and_name';
  stats: SigninBrandingStats;
  /**
   * True si el tenant tiene activada la página pública de membresía (/unete).
   * El login solo enseña el enlace "Ver la membresía" cuando lleva a algún
   * sitio — en un tenant sin membresía sería un enlace a un 404.
   */
  membershipPageActive: boolean;
}

/** Defaults Didacta (los mismos de `DEFAULT_THEME` en mod.theming). */
const DEFAULT_BRAND_HUE = 213;
const DEFAULT_BRAND_SATURATION = 70;

/** Roles de equipo: no son alumnos y no cuentan en «alumnos activos». */
const STAFF_ROLES = ['super_admin', 'tenant_admin', 'formador'];

const EMPTY: SigninBrandingContext = {
  headline: null,
  subheadline: null,
  brandHue: DEFAULT_BRAND_HUE,
  brandSaturation: DEFAULT_BRAND_SATURATION,
  logoDisplayMode: 'logo_only',
  stats: { activeMembers: 0, publishedCourses: 0 },
  membershipPageActive: false,
};

@Injectable()
export class SigninContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Best-effort: cualquier fallo devuelve el contexto vacío para que /signin
   * siga renderizando (el formulario nunca depende del branding).
   */
  async get(tenantId: string): Promise<SigninBrandingContext> {
    try {
      const [theme, activeMembers, publishedCourses, membership] = await Promise.all([
        this.prisma.modThemingTenantTheme.findUnique({
          where: { tenantId },
          select: {
            signinHeadline: true,
            signinSubheadline: true,
            brandHue: true,
            brandSaturation: true,
            logoDisplayMode: true,
          },
        }),
        this.prisma.user.count({
          where: {
            tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            NOT: { roles: { some: { role: { name: { in: STAFF_ROLES } } } } },
          },
        }),
        this.prisma.modCoursesCourse.count({
          where: { tenantId, status: 'PUBLISHED', deletedAt: null },
        }),
        this.prisma.modSubscriptionsMembershipConfig.findUnique({
          where: { tenantId },
          select: { active: true },
        }),
      ]);
      return {
        headline: theme?.signinHeadline ?? null,
        subheadline: theme?.signinSubheadline ?? null,
        brandHue: theme?.brandHue ?? DEFAULT_BRAND_HUE,
        brandSaturation: theme?.brandSaturation ?? DEFAULT_BRAND_SATURATION,
        logoDisplayMode: theme?.logoDisplayMode === 'logo_and_name' ? 'logo_and_name' : 'logo_only',
        stats: { activeMembers, publishedCourses },
        membershipPageActive: membership?.active ?? false,
      };
    } catch (err) {
      this.logger.warn(
        { err, tenantId },
        'tenant-context: no se pudo resolver el branding de acceso — panel sin copy ni cifras',
      );
      return EMPTY;
    }
  }
}
