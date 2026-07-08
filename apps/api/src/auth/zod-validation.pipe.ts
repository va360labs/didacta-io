import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }));
      // El `message` lleva el detalle real de cada problema (p. ej. "Documento
      // de identidad inválido…") en vez de un genérico "Validación fallida": así
      // el usuario sabe exactamente qué corregir. El front muestra `message`
      // directamente; los `issues` siguen disponibles para UI por campo.
      throw new BadRequestException({
        message: issues.map((i) => i.message).join(' · ') || 'Validación fallida',
        issues,
      });
    }
    return result.data;
  }
}
