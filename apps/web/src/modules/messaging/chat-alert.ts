/**
 * Aviso sonoro del chat flotante: un tono corto y suave cuando llega un mensaje
 * con la píldora plegada.
 *
 * Se sintetiza con WebAudio en vez de servir un fichero de audio: son dos notas
 * de 180 ms, así que un .mp3 seria una peticion de red y un asset que versionar
 * para algo que cabe en veinte lineas. Ademas permite mantenerlo REALMENTE
 * tenue (ganancia 0.05) sin depender de como se masterizo el fichero.
 */

const SOUND_PREF_KEY = 'didacta:chat-flotante:sonido';

/** Ganancia de pico. Muy por debajo de un tono "de notificación" al uso. */
const PEAK_GAIN = 0.05;

/** ¿Suena al llegar un mensaje con el chat plegado? Por defecto sí. */
export function isChatSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) !== '0';
  } catch {
    // Almacenamiento bloqueado: mejor sonar que quedarse mudo sin poder
    // arreglarlo, la preferencia se puede volver a tocar en cada sesión.
    return true;
  }
}

export function setChatSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, enabled ? '1' : '0');
  } catch {
    /* sin persistencia: la preferencia dura lo que la pestaña */
  }
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Los navegadores no dejan sonar nada hasta que el usuario ha interactuado con
 * la página. Se engancha al primer gesto para tener el contexto listo cuando
 * llegue el primer mensaje, en vez de perder ese aviso.
 */
export function primeChatSound(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const unlock = () => {
    const context = getContext();
    if (context && context.state === 'suspended') void context.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

/**
 * Dos notas ascendentes muy cortas. Best-effort puro: si el navegador no deja
 * sonar, no pasa nada — el toast y la burbuja roja siguen avisando.
 */
export function playChatChime(): void {
  if (!isChatSoundEnabled()) return;
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') void context.resume();

  try {
    const now = context.currentTime;
    // La segunda nota entra cuando la primera ya está cayendo: se percibe como
    // un solo "tin", no como dos pitidos.
    playNote(context, 880, now, 0.16);
    playNote(context, 1174.66, now + 0.09, 0.18);
  } catch {
    /* audio no disponible: el aviso visual ya está */
  }
}

function playNote(context: AudioContext, frequency: number, at: number, duration: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, at);
  // Ataque de 12 ms y caída exponencial: sin el ataque suena un "click".
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}
