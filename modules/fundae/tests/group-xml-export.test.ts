import { describe, expect, it } from 'vitest';
import { buildGroupStartXml } from '../src/group-xml-export.js';
import type { ActionView } from '../src/dto.js';
import type { CompanyView } from '../src/company.dto.js';
import type { GroupView } from '../src/group.dto.js';

const ACTION: ActionView = {
  id: 'a1',
  tenantId: 't1',
  courseId: null,
  codigoAccion: 'ACC-001',
  nombre: 'Curso ejemplo & test',
  modalidad: 'PRESENCIAL',
  criterioFinalizacion: 'UMBRAL_PROGRESO',
  horasFormacion: 20,
  fechaInicio: '2026-09-01',
  fechaFin: '2026-09-30',
  lugar: null,
  cifCentro: 'A12345674',
  notas: null,
  status: 'ACTIVE',
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
};

const GROUP: GroupView = {
  id: 'g1',
  tenantId: 't1',
  actionId: 'a1',
  companyId: 'c1',
  numeroGrupo: 1,
  modalidad: 'PRESENCIAL',
  fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
  fechaFinPrevista: '2026-09-30T18:00:00.000Z',
  fechaInicioReal: null,
  fechaFinReal: null,
  status: 'DRAFT',
  creditoEstimadoCents: 50_000_00,
  creditoConsumidoCents: 0,
  // El XML de fin de grupo emite `<umbralFinalizacionPct>`; sin este campo el
  // fixture generaba `undefined` en la salida y nadie se enteraba. 75 es el
  // default de la columna en el schema.
  umbralFinalizacionPct: 75,
  costsByTipo: { DIRECTO: 0, INDIRECTO: 0, ORGANIZACION: 0 },
  notas: null,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
};

const COMPANY: CompanyView = {
  id: 'c1',
  tenantId: 't1',
  nif: 'P1234567D',
  razonSocial: 'Empresa "Ejemplo" SL',
  cccPrincipal: '28010001234',
  plantilla: 50,
  creditoTotalCents: 500_000_00,
  creditoUsadoCents: 0,
  creditoDisponibleCents: 500_000_00,
  datosContacto: {},
  notas: null,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  deletedAt: null,
};

describe('buildGroupStartXml (LMS-83)', () => {
  it('genera XML válido con cabecera y root tag esperados', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
      generatedAt: new Date('2026-04-29T12:00:00Z'),
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<comunicacionInicioGrupo');
    expect(xml).toContain('xmlns="https://www.fundae.es/schemas/grupo-inicio/v1"');
    expect(xml).toContain('<generadoEn>2026-04-29T12:00:00.000Z</generadoEn>');
    expect(xml.endsWith('</comunicacionInicioGrupo>')).toBe(true);
  });

  it('embeda los datos de la acción, grupo y empresa', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
    });
    expect(xml).toContain('<codigoAccion>ACC-001</codigoAccion>');
    expect(xml).toContain('<numeroGrupo>1</numeroGrupo>');
    expect(xml).toContain('<nif>P1234567D</nif>');
    expect(xml).toContain('<ccc>28010001234</ccc>');
    expect(xml).toContain('<plantilla>50</plantilla>');
    expect(xml).toContain('<creditoTotalEur>500000.00</creditoTotalEur>');
    expect(xml).toContain('<creditoEstimadoEur>50000.00</creditoEstimadoEur>');
  });

  it('escapa caracteres XML peligrosos', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
    });
    expect(xml).toContain('Curso ejemplo &amp; test');
    expect(xml).toContain('Empresa &quot;Ejemplo&quot; SL');
    expect(xml).not.toMatch(/<nombre>Curso ejemplo & test<\/nombre>/);
  });

  it('renderiza centro impartidor desde action.cifCentro si no se override', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
    });
    expect(xml).toContain('<centro>');
    expect(xml).toContain('<cif>A12345674</cif>');
    expect(xml).toContain('</centro>');
  });

  it('omite centro si action.cifCentro es null y no llega override', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: { ...ACTION, cifCentro: null },
      company: COMPANY,
      participants: [],
    });
    expect(xml).not.toContain('<centro>');
  });

  it('lista participantes con NIF, nombre y email', () => {
    const xml = buildGroupStartXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [
        {
          userId: 'u1',
          nombre: 'Juan Pérez',
          email: 'juan@example.com',
          nifAlumno: '12345678Z',
          enrolledAt: '2026-04-28T00:00:00.000Z',
        },
        {
          userId: 'u2',
          nombre: null,
          email: 'sin-nif@example.com',
          nifAlumno: null,
          enrolledAt: '2026-04-28T01:00:00.000Z',
        },
      ],
    });
    expect(xml).toContain('<participantesIniciales total="2">');
    expect(xml).toContain('<userId>u1</userId>');
    expect(xml).toContain('<nif>12345678Z</nif>');
    expect(xml).toContain('<nombre>Juan Pérez</nombre>');
    expect(xml).toContain('<email>juan@example.com</email>');
    expect(xml).toContain('<userId>u2</userId>');
    expect(xml).toContain('<email>sin-nif@example.com</email>');
    // u2 sin NIF: el bloque no debe contener el tag para u2
    const u2Block = xml.split('<userId>u2</userId>')[1] ?? '';
    const u2BeforeClose = u2Block.split('</participante>')[0] ?? '';
    expect(u2BeforeClose).not.toContain('<nif>');
  });

  it('renderiza fechaInicioReal si está set', () => {
    const xml = buildGroupStartXml({
      group: { ...GROUP, status: 'ACTIVE', fechaInicioReal: '2026-09-01T08:30:00.000Z' },
      action: ACTION,
      company: COMPANY,
      participants: [],
    });
    expect(xml).toContain('<fechaInicioReal>2026-09-01T08:30:00.000Z</fechaInicioReal>');
  });
});
