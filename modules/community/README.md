# mod.community

Módulo de comunidad de Didacta: posts, comentarios y reacciones.

## Alcance v0.1 (este package)

- Modelos Prisma: `Post`, `Comment`, `Reaction`.
- Posts del tenant, opcionalmente vinculados a un curso (`courseId`).
- Comments en flat (sin nested threads en v0.1).
- Reacciones simples por emoji (`👍 ❤️ 🎉` etc.) sobre Post o Comment.
- Service base con CRUD interno + listado por tenant/curso.
- Eventos: `community.post.created`, `community.comment.created`, `community.reaction.added`.

## Fuera de alcance v0.1 (PRs futuros)

- Endpoints HTTP (PR B).
- UI alumno (PR C): lista de posts en `/comunidad` + detalle con form de comment.
- Moderación (soft-delete + flagging).
- Nested replies a comments.
- Menciones (`@usuario`).
- Notificaciones via NotificationHub cuando alguien responde a tu post (PR D, fácil de añadir reusando el bridge existente).

## Anti-patrones que el módulo respeta

- Sin FKs cross-module: `userId` y `courseId` son UUIDs lógicos sin `@relation` a tablas de IAM/courses.
- Todo modelo persiste `tenantId` y se filtra por él en cada query.
- Service sin acoplamiento a HTTP — `apps/api` lo expone via controllers en otra capa.
