import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Sincroniza el precio de los cursos SUELTOS desde la tienda WooCommerce.
 *
 * Por qué existe: el precio de cada curso individual vive en la tienda
 * (va360.academy). La membresía NO se toca — esa se gobierna desde Didacta.
 *
 * Regla de negocio, que es la parte que no es obvia: en la tienda conviven dos
 * clases de producto. Los que venden UN ÚNICO curso fijan el precio individual
 * de ese curso; los que venden VARIOS son packs (la membresía) y se ignoran, o
 * acabaríamos poniendo el precio del pack a cada curso que incluye.
 *
 * El emparejamiento es por el id de LearnDash que los cursos ya guardan
 * (`externalSource='learndash'` + `externalId`), no por título: un cambio de
 * nombre en cualquiera de los dos lados no rompe nada.
 *
 * Es idempotente: relanzarlo sin cambios en la tienda no toca nada.
 *
 * Vive en el host (no en un módulo) porque ORQUESTA dos módulos:
 * mod.payment-connections lee la tienda y mod.billing pone el precio. Mismo
 * patrón que el resto de controladores que combinan services del registry.
 */
@Injectable()
export class WooCommercePriceSyncService {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  async sync(tenantId: string, opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
    const catalogo = await this.registry
      .getPaymentConnectionsService()
      .listWooCommerceCatalog(tenantId);

    if (catalogo.length === 0) {
      return {
        tiendaConectada: false,
        aplicados: [],
        packsIgnorados: [],
        sinEmparejar: [],
      };
    }

    // Cursos del tenant indexados por su id de LearnDash.
    const cursos = await this.prisma.modCoursesCourse.findMany({
      where: { tenantId, deletedAt: null, externalSource: 'learndash' },
      select: { id: true, title: true, status: true, externalId: true },
    });
    const porExternalId = new Map(cursos.map((c) => [String(c.externalId), c]));

    const aplicados: SyncItem[] = [];
    const packsIgnorados: PackItem[] = [];
    const sinEmparejar: SkipItem[] = [];

    for (const producto of catalogo) {
      const cursosProducto = [...new Set(producto.relatedCourseIds)];
      if (cursosProducto.length === 0) continue; // no vende cursos
      if (cursosProducto.length > 1) {
        // Un producto que da varios cursos puede ser dos cosas MUY distintas:
        // un pack/membresía (VA360 PRO: 5-12 cursos), o la venta de un curso
        // con algún extra de regalo (p. ej. "Curso de MAKE" incluye también
        // "Clases en Directo"). No se puede decidir cuál es el principal desde
        // los datos, así que se informa con los cursos afectados y el precio
        // para que el admin lo resuelva, en vez de descartarlo en silencio.
        const titulos = cursosProducto
          .map((c) => porExternalId.get(c)?.title)
          .filter((t): t is string => Boolean(t));
        packsIgnorados.push({
          producto: producto.name,
          cursos: cursosProducto.length,
          importeCents: aCentimos(producto.price),
          cursosAfectados: titulos,
          motivo:
            cursosProducto.length > 3
              ? 'pack de varios cursos: es la membresía, no fija precio individual'
              : 'vende varios cursos a la vez: decide cuál es el principal para fijarle este precio',
        });
        continue;
      }
      if (producto.type !== 'simple') {
        sinEmparejar.push({
          producto: producto.name,
          motivo: `tipo "${producto.type}": solo se sincronizan productos de pago único`,
        });
        continue;
      }

      const curso = porExternalId.get(cursosProducto[0]!);
      if (!curso) {
        sinEmparejar.push({
          producto: producto.name,
          motivo: `el curso ${cursosProducto[0]} de la tienda no existe en Didacta (o no se importó desde LearnDash)`,
        });
        continue;
      }
      if (curso.status !== 'PUBLISHED') {
        sinEmparejar.push({
          producto: producto.name,
          motivo: `el curso "${curso.title}" está en ${curso.status}: no se pone a la venta un borrador`,
        });
        continue;
      }

      const importe = aCentimos(producto.price);
      if (importe === null) {
        sinEmparejar.push({ producto: producto.name, motivo: 'el producto no tiene precio' });
        continue;
      }
      // El precio tachado solo si la oferta está VIGENTE: WooCommerce refleja el
      // precio efectivo en `price`, así que una oferta programada a futuro tiene
      // `sale_price` pero `price` sigue siendo el regular. Sin esta comprobación
      // anunciaríamos un descuento que no se está aplicando.
      const rebajado = aCentimos(producto.salePrice);
      const regular = aCentimos(producto.regularPrice);
      const ofertaVigente =
        rebajado !== null && regular !== null && importe === rebajado && regular > rebajado;

      if (opts.dryRun) {
        aplicados.push({
          curso: curso.title,
          producto: producto.name,
          importeCents: importe,
          antesCents: ofertaVigente ? regular : null,
          accion: 'dry-run',
        });
        continue;
      }

      const r = await this.registry.getBillingService().upsertCoursePrice({
        tenantId,
        courseId: curso.id,
        unitAmount: importe,
        currency: 'eur',
        compareAtAmount: ofertaVigente ? regular : null,
        name: curso.title,
      });
      aplicados.push({
        curso: curso.title,
        producto: producto.name,
        importeCents: r.product.unitAmount,
        antesCents: r.product.compareAtAmount ?? null,
        accion: r.accion,
      });
    }

    this.logger.log(
      {
        tenantId,
        aplicados: aplicados.length,
        packs: packsIgnorados.length,
        sinEmparejar: sinEmparejar.length,
      },
      'sincronización de precios desde WooCommerce completada',
    );

    return { tiendaConectada: true, aplicados, packsIgnorados, sinEmparejar };
  }
}

export interface SyncItem {
  curso: string;
  producto: string;
  importeCents: number;
  antesCents: number | null;
  accion: 'creado' | 'actualizado' | 'sin-cambios' | 'dry-run';
}
export interface PackItem {
  producto: string;
  cursos: number;
  importeCents: number | null;
  cursosAfectados: string[];
  motivo: string;
}
export interface SkipItem {
  producto: string;
  motivo: string;
}
export interface SyncReport {
  tiendaConectada: boolean;
  aplicados: SyncItem[];
  packsIgnorados: PackItem[];
  sinEmparejar: SkipItem[];
}

/** "67", "47.70" o "47,70" → céntimos. Null si no es un importe positivo. */
function aCentimos(valor: string | null): number | null {
  if (!valor) return null;
  const n = parseFloat(valor.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
