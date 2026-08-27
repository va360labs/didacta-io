# Cómo se trabaja en este repo

## Cómo quiere Valen que le respondas

**Decide tú. No preguntes lo que puedes resolver.**

- **Máximo 2 líneas de respuesta.** El detalle va en el código, en los mensajes de
  commit y en los ficheros de trabajo — no en el chat.
- **Nada de menús de opciones.** Si hay que elegir entre caminos, elige el mejor
  y hazlo. Se anota la decisión y el porqué en el commit, y si resulta estar mal
  se corrige; eso cuesta menos que una ronda de preguntas.
- **Preguntar solo si sin la respuesta el trabajo sale inútil o es irreversible**:
  borrar datos, enviar un correo, publicar algo a nombre de la empresa, gastar
  dinero. Todo lo demás se decide y se cuenta después en una línea.
- **Calidad por encima de velocidad.** No escatimes: si hace falta montar una base
  desechable para probar un script de verdad, se monta. Lo que no se quiere es
  ir rápido a costa de entregar algo sin verificar.
- **Verificar de verdad, con control al lado.** Un 200 no prueba nada sin un 404
  de control que demuestre que la comprobación discrimina.

## Trampas de este repo que ya han costado tiempo

- **`pnpm -r build` NO mira los tests.** Antes de dar nada por verde:
  `pnpm -r build` **y** `pnpm typecheck` **y** `pnpm -r test` **y** `eslint .`.
- **Los checks de CI tampoco miran la imagen.** Un import fantasma pasa los cinco
  checks y revienta en `docker build`. Antes de taguear una release:
  `docker build --target builder .`
- **`@prisma/client` solo lo declara `packages/database`.** Hay una regla de lint
  que lo prohíbe fuera; si falta un enum, se reexporta desde ahí.
- **Nunca `Co-Authored-By: Claude`** ni pie de «Generated with». Hay un hook, pero
  no cubre `--no-verify`.
- **`main` no se mergea.** La release va con fast-forward (`git push origin
develop:main`) y el tag se pone **sobre `main`**.
- **Varias sesiones pueden compartir este worktree.** Antes de commitear, mirar
  `git status` entero; nunca `git switch` ni `git add -A` a ciegas.
- **RLS está FORZADA incluso para el dueño.** Un script que consulte sin
  `withTenantContext` no ve ni una fila y dirá que no hay nada que hacer.
