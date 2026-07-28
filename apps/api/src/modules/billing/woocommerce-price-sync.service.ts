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
      // Un producto que da varios cursos puede ser dos cosas MUY distintas: un
      // pack/membresía (VA360 PRO: 5-12 cursos), o la venta de UN curso con
      // algún extra de regalo — los tres cursos que se venden por niveles
      // incluyen además "Clases en Directo". En el segundo caso el curso
      // principal se reconoce porque el NOMBRE del producto se parece al del
      // curso; si ninguno se parece lo bastante, no se adivina: se informa.
      let curso = cursosProducto.length === 1 ? porExternalId.get(cursosProducto[0]!) : undefined;
      let atribuidoPorNombre = false;
      if (!curso && cursosProducto.length > 1 && cursosProducto.length <= MAX_CURSOS_CON_EXTRA) {
        const candidatos = cursosProducto
          .map((c) => porExternalId.get(c))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        const mejor = elegirPrincipal(producto.name, candidatos);
        if (mejor) {
          curso = mejor;
          atribuidoPorNombre = true;
        }
      }

      if (!curso) {
        const titulos = cursosProducto
          .map((c) => porExternalId.get(c)?.title)
          .filter((t): t is string => Boolean(t));
        packsIgnorados.push({
          producto: producto.name,
          cursos: cursosProducto.length,
          importeCents: aCentimos(producto.price),
          cursosAfectados: titulos,
          motivo:
            cursosProducto.length > MAX_CURSOS_CON_EXTRA
              ? 'pack de varios cursos: es la membresía, no fija precio individual'
              : 'vende varios cursos y ninguno coincide con el nombre del producto: asígnalo a mano',
        });
        continue;
      }

      if (cursosProducto.length === 1 && !porExternalId.get(cursosProducto[0]!)) {
        sinEmparejar.push({
          producto: producto.name,
          motivo: `el curso ${cursosProducto[0]} de la tienda no existe en Didacta (o no se importó desde LearnDash)`,
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

      // El nombre de la VARIANTE es el nombre de la opción de compra ("Curso",
      // "Curso Intermedio", "Curso Avanzado"). En un producto simple no hay
      // variante y el curso tiene precio único.
      const optionName = nombreDeOpcion(producto.name);
      const orden = ORDEN_OPCIONES.findIndex((o) => optionName.toLowerCase().includes(o));

      if (opts.dryRun) {
        aplicados.push({
          curso: curso.title,
          producto: producto.name,
          opcion: optionName,
          importeCents: importe,
          antesCents: ofertaVigente ? regular : null,
          atribuidoPorNombre,
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
        optionName,
        sortOrder: orden >= 0 ? orden : 0,
        externalRef: producto.id,
      });
      aplicados.push({
        curso: curso.title,
        producto: producto.name,
        opcion: r.product.name,
        importeCents: r.product.unitAmount,
        antesCents: r.product.compareAtAmount ?? null,
        atribuidoPorNombre,
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
  /** Nombre de la opción de compra. "" = el curso tiene precio único. */
  opcion: string;
  importeCents: number;
  antesCents: number | null;
  /** True si el curso se dedujo del nombre del producto (venía con extras). */
  atribuidoPorNombre: boolean;
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

/** Fila de curso tal y como la selecciona este servicio. */
type CursoRow = {
  id: string;
  title: string;
  status: string;
  externalId: string | null;
};

/**
 * Hasta cuántos cursos puede dar un producto para seguir considerándolo la
 * venta de UNO con extras. Por encima es un pack/membresía.
 */
const MAX_CURSOS_CON_EXTRA = 3;

/** Orden de presentación de las opciones típicas, de menor a mayor. */
const ORDEN_OPCIONES = ['curso avanzado', 'curso intermedio', 'curso'];

/**
 * El nombre de la variante viene pegado al del producto ("Curso de MAKE — Curso
 * Intermedio"). Nos quedamos con la parte de la variante.
 */
function nombreDeOpcion(nombreProducto: string): string {
  const i = nombreProducto.lastIndexOf(' — ');
  return i >= 0 ? nombreProducto.slice(i + 3).trim() : '';
}

/** Palabras que no distinguen un curso de otro y solo añaden ruido al comparar. */
const RUIDO = new Set([
  'curso',
  'cursos',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'a',
  'y',
  'o',
  'en',
  'con',
  'para',
  'por',
  'cero',
  'experto',
  'experta',
  'edicion',
  'edición',
  'online',
  'completo',
  'masterclass',
  'pro',
]);

function tokens(texto: string): Set<string> {
  return new Set(
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => t.length > 1 && !RUIDO.has(t)),
  );
}

/**
 * De entre los cursos que otorga un producto, cuál es el PRINCIPAL: el que más
 * palabras significativas comparte con el nombre del producto. Devuelve null si
 * ninguno alcanza el mínimo — preferimos no decidir a decidir mal, porque
 * equivocarse aquí significa poner un precio al curso que no era.
 */
function elegirPrincipal<T extends { title: string }>(
  nombreProducto: string,
  candidatos: T[],
): T | null {
  const tp = tokens(nombreProducto);
  let mejor: T | null = null;
  let mejorPuntos = 0;
  let empate = false;
  for (const c of candidatos) {
    const tc = tokens(c.title);
    let puntos = 0;
    for (const t of tc) if (tp.has(t)) puntos += 1;
    if (puntos > mejorPuntos) {
      mejorPuntos = puntos;
      mejor = c;
      empate = false;
    } else if (puntos === mejorPuntos && puntos > 0) {
      empate = true;
    }
  }
  if (mejorPuntos < 1 || empate) return null;
  return mejor;
}

/** "67", "47.70" o "47,70" → céntimos. Null si no es un importe positivo. */
function aCentimos(valor: string | null): number | null {
  if (!valor) return null;
  const n = parseFloat(valor.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
