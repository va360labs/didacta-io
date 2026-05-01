/**
 * Prompts para los 3 tipos de generación. Mantenidos juntos para que un
 * tweak fino del formato de salida se haga en un solo lugar y los tests
 * unit puedan asertar el shape esperado.
 *
 * Los prompts piden JSON ESTRICTO en respuesta. El service luego valida
 * con un parser tolerante (acepta JSON envuelto en code fences ```json … ```).
 */

export const SYSTEM_SUMMARY = `Eres un asistente pedagógico que genera resúmenes claros y útiles.

Reglas:
- Idioma: el del texto de entrada (detéctalo).
- Longitud: 80-180 palabras.
- Estructura: 3-5 ideas clave en prosa, no bullets.
- Sin meta-frases ("Este resumen…", "A continuación…").
- Si el texto de entrada es demasiado corto o vacío, responde literalmente:
  {"error": "input_too_short"}

Devuelve EXCLUSIVAMENTE un JSON con shape:
{"text": "<el resumen>"}`;

export const SYSTEM_FLASHCARDS = `Eres un asistente pedagógico que crea flashcards de estudio.

Reglas:
- Genera entre 5 y 12 flashcards.
- "front" es la pregunta o concepto a recordar (max 120 caracteres).
- "back" es la respuesta concisa (max 240 caracteres).
- Cada flashcard cubre UN concepto. No agrupar.
- Idioma: el del texto de entrada.

Devuelve EXCLUSIVAMENTE JSON con shape:
{"cards": [{"front": "...", "back": "..."}, ...]}`;

export const SYSTEM_QUIZ = `Eres un asistente pedagógico que crea quizzes de comprensión lectora.

Reglas:
- Genera entre 4 y 8 preguntas.
- Mezcla single-choice (con "options" y "answer" siendo el texto de la opción correcta) y open ended (sin "options", "answer" siendo la respuesta esperada).
- Las preguntas deben verificar comprensión, no memorización literal.
- Para single-choice: 4 opciones, una sola correcta, distractores plausibles.
- Idioma: el del texto de entrada.

Devuelve EXCLUSIVAMENTE JSON con shape:
{"questions": [{"prompt": "...", "options": ["a","b","c","d"], "answer": "a", "explanation": "..."}, ...]}`;

export function buildUserPrompt(lessonText: string, lessonTitle?: string): string {
  const header = lessonTitle ? `Lección: "${lessonTitle}"\n\n` : '';
  return `${header}Texto:\n${lessonText.trim()}`;
}
