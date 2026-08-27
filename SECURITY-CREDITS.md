# Créditos de seguridad

Gracias a quienes se han tomado el trabajo de mirar el código de Didacta y
contarnos con calma lo que encontraron, en privado y antes de publicarlo.

Esta lista es opt-in: aparece aquí quien lo pidió expresamente. Si reportaste
algo y prefieres no figurar, no figuras.

Para reportar, ver [SECURITY.md](SECURITY.md).

---

## 2026

### Bruno — [ingenierosindustriales.com](https://ingenierosindustriales.com)

Reportó el 26 de agosto de 2026, por `security@didacta.io` y siguiendo la
política, tres hallazgos sobre `v0.1.0-beta.7`:

| Severidad   | Hallazgo                                                                                                                                                                                                                                                                                                                         | Estado    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Crítica** | Escape del sandbox de módulos y ejecución de código en el proceso de la API. `node:vm` no aísla realms: los intrínsecos del anfitrión inyectados en el contexto daban acceso al `Function` del host, y `codeGeneration: { strings: false }` no lo alcanza. La verificación de firma se calculaba pero no gobernaba la ejecución. | Corregido |
| **Alta**    | XSS almacenado en lecciones HTML. El saneado que el código decía hacer en el servidor no existía, y las lecciones de tipo HTML se renderizaban crudas.                                                                                                                                                                           | Corregido |
| **Baja**    | Rate limit anónimo global en lugar de por cliente: todo el tráfico público de la instancia compartía un único cubo.                                                                                                                                                                                                              | Corregido |

Aportó PoC reproducible y comprobado, análisis de impacto correcto —incluida la
cadena hasta `AUTH_SECRET`, la clave de cifrado de secretos de tenant y el
bypass de RLS vía `SET ROLE`—, referencia a la documentación de Node sobre
`node:vm`, y mitigaciones concretas que hemos seguido casi al pie de la letra.

Dos detalles que dicen más que los hallazgos: corrigió por iniciativa propia
una observación suya anterior que era inexacta (creía que sólo había una
etiqueta cuando sí existía un diálogo de advertencia), y señaló que la
diferencia real no era la etiqueta sino que el aviso llegaba **después** de
instalar. Y no dio por cierto lo que no había medido: dijo explícitamente que
el impacto del rate limit necesitaría una prueba de carga para afirmarse.

Gracias, Bruno.
