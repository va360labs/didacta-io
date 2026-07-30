import { describe, expect, it } from 'vitest';
import {
  agruparSegmentos,
  formatMmSs,
  normalizeTranscript,
  parseSubtitles,
  segmentosATexto,
} from './transcript';

const SRT = `1
00:00:00,000 --> 00:00:03,120
Hola, bienvenidos al capítulo de webhooks.

2
00:00:03,120 --> 00:00:07,400
Lo primero que vamos a hacer es crear el nodo.

3
00:12:34,000 --> 00:12:38,000
Y aquí es donde se securiza.
`;

const VTT = `WEBVTT

NOTE grabado con Whisper

00:00:01.000 --> 00:00:04.000
<v Valen>Vamos a ver el nodo HTTP.

00:01:05.500 --> 00:01:09.000
Fíjate en la cabecera.
`;

describe('parseSubtitles', () => {
  it('lee un SRT y saca marca de tiempo + texto', () => {
    const s = parseSubtitles(SRT);
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({
      startSeconds: 0,
      text: 'Hola, bienvenidos al capítulo de webhooks.',
    });
    expect(s[2]!.startSeconds).toBe(754);
  });

  it('lee un WebVTT y limpia cabecera, notas y etiquetas de voz', () => {
    const s = parseSubtitles(VTT);
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toBe('Vamos a ver el nodo HTTP.');
    expect(s[1]!.startSeconds).toBe(65);
  });

  it('junta las líneas de un mismo bloque', () => {
    const s = parseSubtitles(`00:00:02,000 --> 00:00:06,000
primera línea
segunda línea`);
    expect(s[0]!.text).toBe('primera línea segunda línea');
  });

  it('texto sin marcas de tiempo → sin segmentos', () => {
    expect(parseSubtitles('Esto es una transcripción a pelo, sin tiempos.')).toEqual([]);
  });
});

describe('agruparSegmentos', () => {
  it('junta trozos cortos conservando el tiempo del primero', () => {
    const s = agruparSegmentos(
      [
        { startSeconds: 0, text: 'a'.repeat(50) },
        { startSeconds: 3, text: 'b'.repeat(50) },
        { startSeconds: 6, text: 'c'.repeat(50) },
      ],
      120,
    );
    expect(s).toHaveLength(1);
    expect(s[0]!.startSeconds).toBe(0);
    expect(s[0]!.text.length).toBe(152); // 50 + espacio + 50 + espacio + 50
  });

  it('no pierde el último buffer aunque no llegue al mínimo', () => {
    const s = agruparSegmentos([{ startSeconds: 9, text: 'corto' }], 500);
    expect(s).toEqual([{ startSeconds: 9, text: 'corto' }]);
  });

  // Si se agrupa sólo por longitud, dos frases separadas por medio vídeo
  // acaban en el mismo bloque y la cita apunta al minuto de la primera.
  it('corta cuando hay un silencio largo entre intervenciones', () => {
    const s = agruparSegmentos(
      [
        { startSeconds: 0, text: 'inicio' },
        { startSeconds: 3, text: 'sigue' },
        { startSeconds: 754, text: 'mucho después' },
      ],
      1000,
      60,
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ startSeconds: 0, text: 'inicio sigue' });
    expect(s[1]).toEqual({ startSeconds: 754, text: 'mucho después' });
  });
});

describe('normalizeTranscript', () => {
  it('SRT → bloques [mm:ss] separados por línea en blanco', () => {
    const r = normalizeTranscript(SRT);
    expect(r.formato).toBe('subtitulos');
    expect(r.text.startsWith('[0:00] Hola, bienvenidos')).toBe(true);
    // Los bloques van separados por línea en blanco: es lo que usa el
    // troceador del indexador para no partir por la mitad una explicación.
    for (const bloque of r.text.split('\n\n')) {
      expect(bloque).toMatch(/^\[\d{1,2}:\d{2}(:\d{2})?\] /);
    }
  });

  it('conserva el minuto exacto de la última intervención', () => {
    expect(normalizeTranscript(SRT).text).toContain('[12:34]');
  });

  it('texto plano se queda como está y lo dice', () => {
    const r = normalizeTranscript('Párrafo uno.\n\nPárrafo dos.');
    expect(r.formato).toBe('texto');
    expect(r.bloques).toBe(2);
    expect(r.text).toBe('Párrafo uno.\n\nPárrafo dos.');
  });

  it('entrada vacía no revienta', () => {
    const r = normalizeTranscript('   \n\n  ');
    expect(r.text).toBe('');
    expect(r.bloques).toBe(0);
  });
});

describe('formatMmSs', () => {
  it('usa h:mm:ss sólo si pasa de la hora', () => {
    expect(formatMmSs(0)).toBe('0:00');
    expect(formatMmSs(754)).toBe('12:34');
    expect(formatMmSs(3723)).toBe('1:02:03');
  });
});

describe('segmentosATexto', () => {
  it('formatea sin dejar espacios sobrantes', () => {
    expect(segmentosATexto([{ startSeconds: 5, text: '  hola  ' }])).toBe('[0:05] hola');
  });
});
