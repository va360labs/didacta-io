import { describe, expect, it } from 'vitest';
import { encodeZoomMeetingId } from '../src/zoom-api-client.js';

/**
 * El gotcha que rompe las Report API de Zoom: un UUID de meeting que empieza
 * por `/` o contiene `//` hay que **doble-encodearlo** en el path, o Zoom
 * responde 404 aunque el meeting exista. Zoom genera esos UUID con
 * regularidad (son base64), así que no es un caso teórico.
 */
describe('encodeZoomMeetingId', () => {
  it('encoda una sola vez un id numérico', () => {
    expect(encodeZoomMeetingId('82103910331')).toBe('82103910331');
  });

  it('encoda una sola vez un uuid sin barras', () => {
    expect(encodeZoomMeetingId('aDbLoAbCdEf==')).toBe('aDbLoAbCdEf%3D%3D');
  });

  it('doble-encoda un uuid que empieza por barra', () => {
    // encodeURIComponent('/abc==') → '%2Fabc%3D%3D' → '%252Fabc%253D%253D'
    expect(encodeZoomMeetingId('/abc==')).toBe('%252Fabc%253D%253D');
  });

  it('doble-encoda un uuid que contiene doble barra', () => {
    expect(encodeZoomMeetingId('ab//cd')).toBe('ab%252F%252Fcd');
  });

  it('no doble-encoda un uuid con una sola barra interior', () => {
    // Una barra suelta en medio no dispara el bug: encode simple basta.
    expect(encodeZoomMeetingId('ab/cd')).toBe('ab%2Fcd');
  });
});
