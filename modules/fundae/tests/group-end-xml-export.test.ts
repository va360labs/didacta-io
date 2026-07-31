import { describe, expect, it } from 'vitest';
import { buildGroupEndXml } from '../src/group-end-xml-export.js';
import type { ActionView } from '../src/dto.js';
import type { CompanyView } from '../src/company.dto.js';
import type { GroupView, CostView } from '../src/group.dto.js';

const ACTION: ActionView = {
  id: 'a1',
  tenantId: 't1',
  courseId: null,
  codigoAccion: 'ACC-FIN-001',
  nombre: 'Curso final',
  modalidad: 'PRESENCIAL',
  horasFormacion: 20,
  fechaInicio: '2026-09-01',
  fechaFin: '2026-09-30',
  lugar: null,
  cifCentro: 'V12345674',
  notas: null,
  status: 'CLOSED',
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
  fechaInicioReal: '2026-09-01T08:30:00.000Z',
  fechaFinReal: '2026-09-30T17:45:00.000Z',
  status: 'CLOSED',
  creditoEstimadoCents: 50_000_00,
  creditoConsumidoCents: 35_000_00,
  costsByTipo: { DIRECTO: 30_000_00, INDIRECTO: 5_000_00, ORGANIZACION: 0 },
  umbralFinalizacionPct: 75,
  notas: null,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
};

const COMPANY: CompanyView = {
  id: 'c1',
  tenantId: 't1',
  nif: 'P1234567D',
  razonSocial: 'Empresa Final SL',
  cccPrincipal: '28010001234',
  plantilla: 50,
  creditoTotalCents: 500_000_00,
  creditoUsadoCents: 35_000_00,
  creditoDisponibleCents: 465_000_00,
  datosContacto: {},
  notas: null,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  deletedAt: null,
};

const COSTS: CostView[] = [
  {
    id: 'co1',
    tenantId: 't1',
    groupId: 'g1',
    tipo: 'DIRECTO',
    concepto: 'Honorarios formador',
    amountCents: 30_000_00,
    notas: null,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
  },
  {
    id: 'co2',
    tenantId: 't1',
    groupId: 'g1',
    tipo: 'INDIRECTO',
    concepto: 'Gestión administrativa',
    amountCents: 5_000_00,
    notas: 'Factura #42',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
  },
];

describe('buildGroupEndXml (LMS-85)', () => {
  it('genera XML válido con cabecera, root tag y fechas reales', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
      costs: COSTS,
      generatedAt: new Date('2026-04-29T13:00:00Z'),
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<comunicacionFinalizacionGrupo');
    expect(xml).toContain('xmlns="https://www.fundae.es/schemas/grupo-fin/v1"');
    expect(xml).toContain('<generadoEn>2026-04-29T13:00:00.000Z</generadoEn>');
    expect(xml).toContain('<fechaInicioReal>2026-09-01T08:30:00.000Z</fechaInicioReal>');
    expect(xml).toContain('<fechaFinReal>2026-09-30T17:45:00.000Z</fechaFinReal>');
    expect(xml).toContain('<umbralFinalizacionPct>75</umbralFinalizacionPct>');
    expect(xml).toContain('<creditoConsumidoEur>35000.00</creditoConsumidoEur>');
    expect(xml.endsWith('</comunicacionFinalizacionGrupo>')).toBe(true);
  });

  it('cuenta APTOS y NO_APTOS en el atributo del bloque participantes', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      costs: [],
      participants: [
        {
          userId: 'u1',
          nombre: 'Juan',
          email: 'juan@x.com',
          nifAlumno: '11111111H',
          enrolledAt: '2026-04-28T00:00:00.000Z',
          horasAsistidas: 18,
          progressPercent: 90,
          resultado: 'APTO',
          completedAt: '2026-09-30T18:00:00.000Z',
        },
        {
          userId: 'u2',
          nombre: 'María',
          email: 'maria@x.com',
          nifAlumno: '22222222J',
          enrolledAt: '2026-04-28T00:00:00.000Z',
          horasAsistidas: 8,
          progressPercent: 40,
          resultado: 'NO_APTO',
          completedAt: '2026-09-30T18:00:00.000Z',
        },
      ],
    });
    expect(xml).toContain('<participantesFinales total="2" aptos="1" noAptos="1">');
    expect(xml).toContain('<resultado>APTO</resultado>');
    expect(xml).toContain('<resultado>NO_APTO</resultado>');
    expect(xml).toContain('<horasAsistidas>18</horasAsistidas>');
    expect(xml).toContain('<progresoPct>90</progresoPct>');
  });

  it('mapea EN_CURSO → NO_APTO en el XML (Fundae no acepta "en curso" en finalización)', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      costs: [],
      participants: [
        {
          userId: 'u1',
          nombre: null,
          email: 'x@x.com',
          nifAlumno: null,
          enrolledAt: '2026-04-28T00:00:00.000Z',
          horasAsistidas: 5,
          progressPercent: 25,
          resultado: 'EN_CURSO',
          completedAt: null,
        },
      ],
    });
    expect(xml).toContain('<resultado>NO_APTO</resultado>');
    expect(xml).not.toContain('<resultado>EN_CURSO</resultado>');
    // Y aparece como noAptos en el atributo agregado.
    expect(xml).toContain('<participantesFinales total="1" aptos="0" noAptos="1">');
  });

  it('agrupa costes por tipo con subtotales y total general', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
      costs: COSTS,
    });
    expect(xml).toContain('<costes total="2" importeTotalEur="35000.00">');
    expect(xml).toContain('<bloque tipo="DIRECTO" subtotalEur="30000.00" lineas="1">');
    expect(xml).toContain('<bloque tipo="INDIRECTO" subtotalEur="5000.00" lineas="1">');
    expect(xml).toContain('<bloque tipo="ORGANIZACION" subtotalEur="0.00" lineas="0">');
    expect(xml).toContain('<concepto>Honorarios formador</concepto>');
    expect(xml).toContain('<importeEur>30000.00</importeEur>');
    expect(xml).toContain('<notas>Factura #42</notas>');
  });

  it('escapa caracteres XML peligrosos en concepto, nombre y razón social', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: { ...COMPANY, razonSocial: 'Empresa "Acme" & Co' },
      costs: [
        {
          id: 'co1',
          tenantId: 't1',
          groupId: 'g1',
          tipo: 'DIRECTO',
          concepto: 'A < B',
          amountCents: 100,
          notas: null,
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      ],
      participants: [],
    });
    expect(xml).toContain('Empresa &quot;Acme&quot; &amp; Co');
    expect(xml).toContain('A &lt; B');
    expect(xml).not.toMatch(/<concepto>A < B<\/concepto>/);
  });

  it('lista 0 participantes y 0 costes correctamente', () => {
    const xml = buildGroupEndXml({
      group: GROUP,
      action: ACTION,
      company: COMPANY,
      participants: [],
      costs: [],
    });
    expect(xml).toContain('<participantesFinales total="0" aptos="0" noAptos="0">');
    expect(xml).toContain('<costes total="0" importeTotalEur="0.00">');
  });
});
