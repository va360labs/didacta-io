/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Agrupado de preguntas parecidas para el informe mensual del tutor IA.
 *
 * El admin no quiere una lista de 400 preguntas: quiere saber QUÉ le están
 * preguntando. "¿cómo instalo el nodo?", "no me deja instalar el nodo" y
 * "instalación del nodo falla" son la misma duda escrita de tres formas, y
 * juntas valen mucho más que por separado — significan que falta material.
 *
 * Agrupamos por embedding porque el texto literal casi nunca se repite. El
 * algoritmo es aglomeración voraz de una pasada: para cada pregunta, se busca
 * el grupo cuyo centroide se le parezca más; si supera el umbral entra ahí, si
 * no abre grupo nuevo. No es k-means, y ese es el punto: no hay que decidir de
 * antemano cuántos temas hay, que es justo lo que no se sabe.
 *
 * Módulo PURO: no toca base de datos ni proveedores. Recibe vectores ya
 * calculados y devuelve grupos. Así se puede testear sin mocks.
 */

/**
 * Similitud coseno de dos vectores de la misma dimensión.
 *
 * Devuelve 0 si alguno es el vector nulo (no hay ángulo que medir). Los
 * embeddings de OpenAI vienen normalizados, así que en la práctica esto es un
 * producto escalar, pero normalizamos igual para no depender del proveedor.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Una pregunta a agrupar. `payload` viaja intacto hasta el resultado. */
export interface ClusterableQuestion<T> {
  /** Texto de la pregunta. Se usa para elegir el representante legible. */
  text: string;
  /** Embedding de `text`. Todos deben tener la misma dimensión. */
  embedding: readonly number[];
  payload: T;
}

export interface QuestionCluster<T> {
  /** Pregunta más representativa: la más cercana al centro del grupo. */
  representative: ClusterableQuestion<T>;
  members: Array<ClusterableQuestion<T>>;
  /** Centroide del grupo. Expuesto para depurar umbrales. */
  centroid: number[];
}

export interface ClusterOptions {
  /**
   * Similitud coseno mínima con el centroide para entrar en un grupo.
   *
   * 0.78 sale de probar con embeddings de `text-embedding-3-small`: dos formas
   * de preguntar lo mismo rondan 0.80-0.92, dos dudas distintas del mismo tema
   * 0.60-0.75. Bajarlo funde temas que el admin quiere ver separados; subirlo
   * devuelve 300 grupos de uno y el informe deja de servir.
   */
  threshold?: number;
  /**
   * Tope de grupos abiertos. Cuando se alcanza, lo que no encaja en ninguno se
   * queda en su propio grupo igualmente — el tope solo evita que comparar
   * contra los centroides se vuelva cuadrático en meses con mucho volumen.
   */
  maxClusters?: number;
}

const DEFAULT_THRESHOLD = 0.78;
const DEFAULT_MAX_CLUSTERS = 400;

/**
 * Agrupa preguntas por similitud y devuelve los grupos ordenados de más a
 * menos numeroso. El orden de entrada no afecta al tamaño de los grupos de
 * forma significativa, pero sí a qué pregunta abre cada grupo; por eso el
 * representante se recalcula al final por cercanía al centroide y no es
 * simplemente la primera.
 */
export function clusterQuestions<T>(
  questions: Array<ClusterableQuestion<T>>,
  options: ClusterOptions = {},
): Array<QuestionCluster<T>> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;

  const clusters: Array<{
    sum: number[];
    centroid: number[];
    members: Array<ClusterableQuestion<T>>;
  }> = [];

  for (const q of questions) {
    if (q.embedding.length === 0) continue;

    let best: (typeof clusters)[number] | null = null;
    let bestSim = -1;
    // Solo se comparan los primeros `maxClusters` centroides: son los grupos
    // más antiguos y, en la práctica, los más poblados.
    const limite = Math.min(clusters.length, maxClusters);
    for (let i = 0; i < limite; i++) {
      const c = clusters[i]!;
      const sim = cosineSimilarity(q.embedding, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }

    if (best && bestSim >= threshold) {
      best.members.push(q);
      for (let i = 0; i < best.sum.length; i++) {
        best.sum[i] = best.sum[i]! + (q.embedding[i] ?? 0);
      }
      best.centroid = best.sum.map((v) => v / best!.members.length);
    } else {
      const sum = [...q.embedding];
      clusters.push({ sum, centroid: [...q.embedding], members: [q] });
    }
  }

  return clusters
    .map((c) => ({
      representative: elegirRepresentante(c.members, c.centroid),
      members: c.members,
      centroid: c.centroid,
    }))
    .sort((a, b) => b.members.length - a.members.length);
}

/**
 * El representante es el miembro más cercano al centroide: es la formulación
 * más "de en medio" del grupo, y por tanto la que mejor lo describe. A igualdad
 * de cercanía gana la más corta, que se lee mejor en una tabla.
 */
function elegirRepresentante<T>(
  members: Array<ClusterableQuestion<T>>,
  centroid: number[],
): ClusterableQuestion<T> {
  let best = members[0]!;
  let bestSim = -Infinity;
  for (const m of members) {
    const sim = cosineSimilarity(m.embedding, centroid);
    if (sim > bestSim || (sim === bestSim && m.text.length < best.text.length)) {
      bestSim = sim;
      best = m;
    }
  }
  return best;
}

/**
 * Convierte el texto que devuelve pgvector (`'[0.1,-0.2,…]'`) en números.
 *
 * Se lee así y no con el tipo nativo porque el cliente de Prisma no expone
 * columnas `Unsupported`: la única vía es `SELECT embedding::text`.
 * Devuelve `[]` ante null o basura — una pregunta sin embedding se salta,
 * nunca revienta el informe.
 */
export function parseVector(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const cuerpo = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (cuerpo === '') return [];
  const out: number[] = [];
  for (const parte of cuerpo.split(',')) {
    const n = Number(parte);
    if (!Number.isFinite(n)) return [];
    out.push(n);
  }
  return out;
}

/** Serializa un vector al literal que acepta pgvector como parámetro. */
export function formatVector(v: readonly number[]): string {
  return '[' + v.join(',') + ']';
}
