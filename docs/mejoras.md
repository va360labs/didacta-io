# Mejoras pendientes — feedback de UX

> Tracker del feedback que llegó tras dogfooding (2026-04-28). Cada item tiene issue espejo en Notion (LMS Ship — Work Items) y se cierra con la PR correspondiente.

## Catálogo de cursos · `https://cloud.didacta.io/cursos`

- [x] Añadir buscador y filtros por temática — [Notion](https://www.notion.so/350b609a124c814a94bff522e559721c) · #204
- [x] Neutralizar el castellano (hay expresiones en argentino como "Hacé") — [Notion](https://www.notion.so/350b609a124c81f697c9e5edb1b00c4f) · #197
- [x] En los cursos, el tiempo (actualmente 3000 min) debe traducirse, por ejemplo 3000 min = 50 h — [Notion](https://www.notion.so/350b609a124c81b8a6c0e94e705bd63e) · #196

## Comunidad · `https://cloud.didacta.io/comunidad`

- [x] El botón de nueva conversación debe abrir un modal con el formulario. No aparecer en línea — [Notion](https://www.notion.so/350b609a124c81fcbbced2fc1f112939) · #202
- [x] Los tags son seleccionables (filtros) — [Notion](https://www.notion.so/350b609a124c81098829e50bbd88e9fb) · #201
- [x] Añadir en administrador de la comunidad "Gestión de tags" con colores e iconos — [Notion](https://www.notion.so/350b609a124c81fdacb1dbcad390131f) · #206
- [x] Permitir a los administradores fijar mensajes en la comunidad — [Notion](https://www.notion.so/350b609a124c81d58073f83ac165b3c7) · #207
- [x] Si un mensaje tiene comentarios debe mostrar el contador de comentarios en lugar de "Ver conversación" — [Notion](https://www.notion.so/350b609a124c8197a359c6ecd8cbf346) · #199
- [x] En ordenar, no se puede modificar nada. Debe permitir: Más recientes, Más Antiguas y Más comentarios — [Notion](https://www.notion.so/350b609a124c81e3bfa3d0a7331a18ab) · #200
- [x] Los botones de reacción deben aparecer también en el listado de mensajes en la home de comunidad — [Notion](https://www.notion.so/350b609a124c81d6b2fbe7cb910e61b6) · #203
- [x] Al abrir un mensaje de comunidad para verlo completo debe abrirse en un modal y no en una sección nueva — [Notion](https://www.notion.so/350b609a124c81a38130f58cf5263188) · #205
- [x] Del mensaje completo, se mostrarán 4 líneas y un "Leer más" que abrirá el modal — [Notion](https://www.notion.so/350b609a124c81d191a4d68acc2de0d2) · #198
- [x] Debo poder añadir una reacción sin entrar en el post — [Notion](https://www.notion.so/350b609a124c811aa192f04ce0983a6e) · #208
- [x] Pintar los tags curados (color/icono) también en el feed, no solo en admin — [Notion](https://www.notion.so/350b609a124c8148a78ac14ae1b3dd0b) · #209

## Curso como Alumno · `https://cloud.didacta.io/cursos/introduccion-n8n`

- [x] Si marco una lección como completada y cambio a otra lección también me aparece como completada y no aparece el botón de completar — [Notion](https://www.notion.so/350b609a124c81069582d90133dbb0b5) · #213
- [x] Echo de menos la opción de poder enviar comentarios/anotaciones en las lecciones. Estos comentarios llegarán como "pendiente de aprobación" al profesor del curso — [Notion](https://www.notion.so/350b609a124c81cfb677ef7bd2c25f60) · #223
- [x] Aún habiendo seleccionado un Quiz y creado, cuando entro en una lección de Quiz aparece -> El quiz solicitado no existe o no pertenece al tenant — [Notion](https://www.notion.so/350b609a124c81ba9b7ce7349928f718) · #214

## Notificaciones como Alumno · `https://cloud.didacta.io/notificaciones`

- [x] Notificación de matriculación muestra el UUID del curso en vez del título — [Notion](https://www.notion.so/350b609a124c81adb803e4891547251b) · #211

## Mis cursos como profesor · `https://cloud.didacta.io/formador/cursos`

- [x] Al crear curso nuevo no debe cambiar de pantalla sino ser un modal y al darle a crear curso pues ya te lleva al builder del curso — [Notion](https://www.notion.so/350b609a124c81769b1cc8e0824ff911) · #216

## Builder del curso como profesor · `https://cloud.didacta.io/formador/cursos/[id]`

- [x] En el curso como alumno hay un espacio para un video pero como profesor no tengo donde configurar ese video. Permitir URL de YouTube — [Notion](https://www.notion.so/350b609a124c812aabb2c7767edc450f) · #217
- [ ] Las categorías de los cursos deben ser como los tags. Un desplegable gestionable que me permita crear X categorías y el profesor las seleccione, una o varias por cada curso (con colores e icono) — [Notion](https://www.notion.so/350b609a124c81b998aec9ccbbcf0d98)
- [x] En la descripción del curso ponme algún editor de texto enriquecido que me permita subir imágenes y demás. No uses ninguno que tenga licencia ni TinyMCE — [Notion](https://www.notion.so/350b609a124c814688d3f527116576fe) · #220

## Creador de aula virtual · `https://cloud.didacta.io/formador/aula-virtual`

- [x] Pide aunque opcional UUID del curso y UUID de la lección. Hacer un seleccionable buscable — [Notion](https://www.notion.so/350b609a124c8197bafbd1595ef04bb7) · #215

## Configuración del tenant · `https://cloud.didacta.io/admin/configuracion`

- [x] No guarda configuración SMTP. Soportar más providers (Amazon SES, SMTP genérico) con envío asíncrono — [Notion](https://www.notion.so/350b609a124c81138670d4b89e5f0208) · #222
- [x] Módulos: usar toggle que guarda al cambio en lugar de form con submit — [Notion](https://www.notion.so/350b609a124c8130b73bcd821f07f55f) · #218
- [x] Storage configurable por tenant: local (Docker volume) / S3 / más — [Notion](https://www.notion.so/350b609a124c814f9934fe9833833181) · #219
- [x] Quitar Branding de Configuración (ya hay sección dedicada en /admin/branding) — [Notion](https://www.notion.so/350b609a124c81e4b20ce8746f8b95c3) · #210
- [x] Plantillas: editor por notificación con soporte multi-language — [Notion](https://www.notion.so/350b609a124c813cb9c2cf60a6693d09) · #221
- [x] La tab "Todos los settings" muestra una vista raw confusa con secretos en ••• y un botón Eliminar. Ocultar o etiquetar como "Avanzado / debug" — [Notion](https://www.notion.so/350b609a124c81f586cbda23dfae8db1) · #212