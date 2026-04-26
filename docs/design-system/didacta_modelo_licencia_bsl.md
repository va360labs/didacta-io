# Didacta: modelo de licencia recomendado

## 1. Objetivo del modelo de licencia

Didacta nace como un LMS moderno, modular, profesional y preparado para entornos educativos, corporativos y regulados.

El objetivo no es simplemente publicar código, sino construir un producto sostenible, con comunidad, transparencia técnica y una vía comercial clara.

La intención estratégica es:

- permitir que la comunidad pueda ver, auditar, probar y contribuir al código;
- evitar que terceros puedan coger Didacta, cambiarle el nombre y venderlo como propio;
- proteger Didacta Cloud como vía oficial SaaS;
- permitir acuerdos comerciales con empresas, academias, universidades, administraciones y consultoras;
- mantener una imagen seria, profesional y alineada con un producto educativo de largo recorrido.

Por tanto, Didacta no debería posicionarse como “open source puro” si se quiere restringir el uso comercial.

La posición correcta sería:

> Didacta es un LMS source-available: puedes ver el código, probarlo, auditarlo y contribuir. Para uso comercial, producción, organizaciones, alumnos reales, servicios gestionados o white-label necesitas una licencia comercial o usar Didacta Cloud.

---

## 2. Diferencia entre open source y source-available

Una licencia open source reconocida por la OSI no puede discriminar campos de uso. Eso significa que no puede prohibir el uso comercial.

Licencias como MIT, Apache, BSD, GPL o AGPL permiten uso comercial, aunque cada una tiene obligaciones diferentes.

Si Didacta quiere exigir acuerdo comercial para cualquier uso comercial, entonces no debe presentarse como open source en sentido estricto.

Debe presentarse como:

- source-available;
- código disponible;
- community-visible;
- open core, si en el futuro hay módulos enterprise cerrados;
- licencia comunitaria con uso comercial bajo acuerdo.

La frase recomendada es:

> Código disponible, comunidad abierta y uso comercial bajo licencia.

---

## 3. Modelos analizados

### 3.1. Modelo WordPress

WordPress está licenciado bajo GPL.

Eso permite que cualquiera pueda:

- usarlo comercialmente;
- modificarlo;
- redistribuirlo;
- crear negocio encima;
- vender hosting;
- vender themes;
- vender plugins;
- crear agencias;
- montar servicios profesionales alrededor.

La ventaja de este modelo es la adopción masiva.

El inconveniente para Didacta es que no permitiría controlar el uso comercial del producto.

Con una licencia tipo WordPress, una consultora podría montar una versión de Didacta, vender implantaciones, ofrecer hosting gestionado o crear una alternativa comercial, siempre que respete la licencia y no use indebidamente la marca.

#### Conclusión sobre WordPress

No es el modelo recomendado para Didacta si el objetivo es que cualquier uso comercial requiera acuerdo.

WordPress es ideal para construir ecosistema masivo, pero no para proteger un SaaS oficial o una licencia comercial centralizada.

---

### 3.2. Modelo n8n

n8n utiliza un modelo fair-code / source-available.

La idea principal es permitir que el código esté disponible y que muchas empresas puedan usarlo internamente, pero limitar usos que compitan directamente con el producto o que conviertan n8n en el motor de un servicio comercial para terceros.

En términos prácticos, el modelo de n8n permite mucho uso interno, pero restringe:

- ofrecer n8n como servicio gestionado;
- montar un SaaS basado en n8n;
- revenderlo como producto propio;
- crear una plataforma cuyo valor derive sustancialmente de n8n;
- hacer white-label sin acuerdo.

#### Conclusión sobre n8n

Es un modelo mucho más cercano a lo que necesita Didacta.

Aun así, n8n permite bastante uso empresarial interno gratuito. Para Didacta, el modelo debería ser más estricto si se quiere que cualquier uso comercial o productivo pase por licencia.

---

### 3.3. Modelo BSL 1.1

La Business Source License 1.1 permite publicar el código con restricciones durante un periodo determinado.

Normalmente permite:

- acceso al código;
- lectura;
- modificación;
- uso en desarrollo;
- uso en pruebas;
- evaluación;
- contribuciones.

Pero puede restringir:

- uso comercial;
- uso productivo;
- uso SaaS;
- uso por terceros;
- uso en empresas;
- uso como servicio gestionado;
- redistribución comercial.

Además, la BSL suele incluir una fecha futura de cambio de licencia, conocida como Change Date. En esa fecha, una versión antigua del software pasa automáticamente a una licencia open source, como GPL, Apache o MIT.

Para Didacta, se podría configurar así:

- licencia actual: Didacta Community License basada en BSL 1.1;
- uso permitido: evaluación, desarrollo, pruebas, investigación no comercial y aprendizaje;
- uso restringido: producción, empresas, academias, universidades, administraciones, consultoras, alumnos reales, clientes reales, SaaS, white-label y servicios gestionados;
- Change Date: 4 años;
- licencia posterior: Apache 2.0, GPLv3 o AGPLv3, según estrategia.

#### Conclusión sobre BSL 1.1

Es el modelo recomendado para Didacta.

Permite tener código visible y comunidad sin perder el control comercial del producto.

---

## 4. Tabla comparativa

| Modelo | Tipo real | ¿Open source OSI? | Uso comercial propio | SaaS/hosting gestionado por terceros | Encaje para Didacta |
|---|---|---:|---:|---:|---|
| WordPress | GPL | Sí | Permitido | Permitido si respeta GPL y marca | Bajo |
| n8n | Fair-code / source-available | No | Uso interno permitido con límites | Restringido | Medio-alto |
| BSL 1.1 | Source-available con cambio futuro | No inicialmente | Configurable | Configurable | Alto |
| Elastic License 2.0 | Source-available | No | Bastante permisivo | Restringido | Medio |
| Commons Clause | Restricción comercial añadida | No | Depende | Restringido | Medio-bajo |
| Didacta Community License | BSL 1.1 adaptada | No inicialmente | Solo con licencia si hay producción/comercial | Prohibido sin acuerdo | Muy alto |

---

## 5. Modelo recomendado para Didacta

La recomendación es crear una licencia propia de producto basada en BSL 1.1:

# Didacta Community License

Basada en:

# Business Source License 1.1

Con una comunicación clara:

> Didacta no es open source puro. Didacta es source-available. El código está disponible para transparencia, aprendizaje, auditoría, evaluación y contribución. El uso comercial, productivo o gestionado requiere licencia comercial o Didacta Cloud.

---

## 6. Usos permitidos sin licencia comercial

Didacta Community puede permitir gratuitamente:

- ver el código;
- clonar el repositorio;
- ejecutar Didacta en local;
- probar la plataforma;
- evaluar funcionalidades;
- hacer auditorías técnicas;
- desarrollar integraciones;
- preparar contribuciones;
- usarlo en investigación no comercial;
- usarlo para aprendizaje personal;
- crear entornos de prueba no productivos;
- hacer demos internas sin usuarios reales;
- formar al equipo internamente sobre el funcionamiento técnico del producto, sin explotación comercial.

Texto recomendado:

```md
Puedes usar Didacta Community gratuitamente para evaluación, desarrollo, pruebas, aprendizaje personal, investigación no comercial y contribución al proyecto.

Este permiso no incluye el uso en producción, el uso con alumnos reales, el uso con clientes, el uso por organizaciones en actividad económica ni la prestación de servicios comerciales basados en Didacta.
```

---

## 7. Usos que requieren licencia comercial

Cualquier uso comercial, productivo u organizativo debería requerir licencia comercial o Didacta Cloud.

Esto incluye:

- empresas;
- academias;
- universidades privadas;
- universidades públicas;
- colegios;
- centros de formación;
- administraciones públicas;
- fundaciones con actividad formativa real;
- consultoras;
- implantadores tecnológicos;
- marketplaces educativos;
- plataformas de cursos;
- proyectos internos con usuarios reales;
- formación corporativa;
- formación a empleados;
- formación a clientes;
- formación a alumnos;
- uso en producción;
- uso con datos reales;
- uso con certificados reales;
- uso con pagos reales;
- uso con usuarios reales;
- uso como parte de un producto o servicio comercial.

Texto recomendado:

```md
Cualquier uso de Didacta en producción, con usuarios reales, alumnos, empleados, clientes, miembros, ciudadanos o terceros requiere una licencia comercial activa o el uso de Didacta Cloud.
```

---

## 8. Usos expresamente prohibidos sin acuerdo

Sin autorización escrita de Didacta, no se debería permitir:

- ofrecer Didacta como SaaS;
- ofrecer Didacta como LMS as a Service;
- ofrecer hosting gestionado de Didacta;
- revender Didacta;
- sublicenciar Didacta;
- distribuir Didacta como parte de una solución comercial;
- crear una versión white-label;
- eliminar marcas o avisos legales;
- ocultar que el producto está basado en Didacta;
- usar Didacta como base de un producto competidor;
- vender implantaciones recurrentes sin acuerdo de partner;
- montar un marketplace no autorizado;
- usar Didacta para competir directamente con Didacta Cloud.

Texto recomendado:

```md
No puedes, sin autorización escrita de Didacta:

- ofrecer Didacta como SaaS, hosting gestionado o LMS as a Service;
- vender servicios cuyo valor derive sustancialmente de Didacta;
- usar Didacta como plataforma para clientes, alumnos o usuarios reales en una actividad comercial;
- revender, sublicenciar o distribuir Didacta como parte de una solución comercial;
- crear una versión white-label o rebrandeada;
- eliminar avisos legales, marcas o referencias de licencia;
- usar Didacta para competir directamente con Didacta Cloud.
```

---

## 9. Didacta Cloud

Didacta Cloud debe ser la vía oficial para quien quiera usar el producto sin preocuparse por instalación, mantenimiento o cumplimiento.

Didacta Cloud puede incluir:

- hosting oficial;
- actualizaciones automáticas;
- backups;
- monitorización;
- soporte técnico;
- módulos de IA;
- integraciones oficiales;
- cumplimiento normativo;
- trazabilidad;
- analítica avanzada;
- certificados;
- gestión de usuarios;
- seguridad reforzada;
- SLA;
- acompañamiento empresarial.

Mensaje comercial recomendado:

```md
Si quieres usar Didacta en producción, con alumnos reales o dentro de una organización, puedes contratar una licencia comercial o utilizar Didacta Cloud, la versión oficial gestionada por el equipo de Didacta.
```

---

## 10. Didacta Enterprise License

Además de Didacta Cloud, debería existir una licencia Enterprise para organizaciones que quieran instalar Didacta en su propia infraestructura.

Esta licencia puede incluir:

- derecho de uso en producción;
- instalación on-premise;
- soporte;
- actualizaciones;
- módulos enterprise;
- integraciones específicas;
- auditoría;
- condiciones de seguridad;
- acuerdos de confidencialidad;
- SLA;
- acompañamiento de implantación;
- derechos para partners o consultoras autorizadas.

Tipos de clientes:

- universidades;
- academias grandes;
- empresas;
- administraciones públicas;
- consultoras tecnológicas;
- centros de formación profesional;
- grupos educativos;
- franquicias educativas;
- grandes comunidades online.

---

## 11. Programa de partners

Para evitar conflictos con consultoras, integradores o agencias, Didacta debería crear un programa de partners autorizado.

Esto permitiría que terceros puedan vender implantaciones, soporte o personalizaciones, pero bajo reglas claras.

Modelo recomendado:

- Partner Registered;
- Partner Certified;
- Partner Enterprise;
- Revenue share o cuota anual;
- obligación de respetar marca y licencia;
- prohibición de white-label salvo acuerdo;
- acceso a documentación avanzada;
- acceso a soporte técnico;
- posibilidad de aparecer en la web oficial.

Texto recomendado:

```md
Las consultoras, agencias e integradores que quieran ofrecer servicios profesionales sobre Didacta deberán formar parte del programa oficial de partners o contar con un acuerdo comercial específico.
```

---

## 12. Repositorio público

En el repositorio se deberían incluir como mínimo estos archivos:

```txt
LICENSE
LICENSE_NOTICE.md
COMMERCIAL_USE.md
README.md
CONTRIBUTING.md
TRADEMARKS.md
SECURITY.md
```

### LICENSE

Debe contener la licencia completa basada en BSL 1.1.

### LICENSE_NOTICE.md

Debe explicar en lenguaje sencillo qué se puede y qué no se puede hacer.

### COMMERCIAL_USE.md

Debe explicar cómo solicitar licencia comercial.

### TRADEMARKS.md

Debe proteger el nombre Didacta, el logo, el isotipo, la identidad visual y el uso de marca.

### CONTRIBUTING.md

Debe indicar que cualquier contribución aceptada pasa a formar parte del proyecto bajo la licencia de Didacta.

---

## 13. Texto recomendado para README

```md
# Didacta

Didacta is a modern, modular and AI-ready Learning Management System designed for education, companies and regulated training environments.

Didacta is source-available, not open source under the OSI definition.

You can view the code, run it locally, evaluate it, audit it and contribute to the project.

Commercial use, production deployments, use by organizations, use with real students or clients, managed hosting, SaaS offerings, white-labeling, resale or any service substantially based on Didacta requires a commercial agreement or the use of Didacta Cloud.

For commercial licensing, contact: licensing@didacta.io
```

---

## 14. Texto recomendado para la web

```md
## Código disponible. Uso comercial bajo licencia.

Didacta es un LMS source-available.

Puedes ver el código, probarlo, auditarlo y contribuir al proyecto.

Para usar Didacta en producción, con alumnos reales, en una organización, como servicio gestionado, como SaaS, en formato white-label o dentro de una actividad comercial, necesitas una licencia comercial o utilizar Didacta Cloud.
```

Versión más comercial:

```md
Didacta combina transparencia técnica con sostenibilidad empresarial.

El código está disponible para la comunidad, pero el uso comercial está protegido para garantizar el desarrollo continuo del producto, la seguridad, el soporte y la evolución de la plataforma.
```

---

## 15. FAQ de licencia

### ¿Didacta es open source?

No en el sentido estricto de la OSI.

Didacta es source-available: el código está disponible públicamente, pero el uso comercial y productivo está sujeto a licencia.

### ¿Puedo probar Didacta gratis?

Sí.

Puedes probarlo localmente, evaluarlo, auditarlo, modificarlo para pruebas y contribuir al proyecto.

### ¿Puedo usar Didacta en mi academia?

Sí, pero necesitas una licencia comercial o usar Didacta Cloud.

### ¿Puedo usar Didacta con alumnos reales?

Sí, pero requiere licencia comercial o Didacta Cloud.

### ¿Puedo instalar Didacta en mi empresa para formar empleados?

Sí, pero si es un uso real o productivo requiere licencia comercial.

### ¿Puedo ofrecer Didacta como SaaS?

No, salvo acuerdo comercial expreso.

### ¿Puedo vender servicios de implantación de Didacta?

Solo si cuentas con acuerdo comercial o formas parte del programa oficial de partners.

### ¿Puedo hacer una versión white-label?

No, salvo acuerdo comercial específico.

### ¿Puedo crear plugins?

Sí, siempre que respeten la licencia, la marca y las condiciones comerciales. Los plugins comerciales podrán requerir condiciones adicionales si se distribuyen como parte de una oferta basada en Didacta.

### ¿Puedo contribuir al proyecto?

Sí. Las contribuciones aceptadas se integrarán en el proyecto bajo la licencia de Didacta.

---

## 16. Frases recomendadas de posicionamiento

- Código visible, negocio protegido.
- Comunidad abierta, uso comercial bajo licencia.
- Transparencia técnica sin renunciar a la sostenibilidad.
- Source-available LMS for modern education.
- El LMS modular, profesional y preparado para IA.
- Puedes probarlo libremente. Para producción, Didacta Cloud o licencia comercial.
- Didacta no es software cerrado. Tampoco es barra libre comercial.

---

## 17. Recomendación final

La recomendación para Didacta es:

```txt
Licencia base: Business Source License 1.1
Nombre público: Didacta Community License
Modelo comercial: Didacta Cloud + Didacta Enterprise License
Posicionamiento: Source-available LMS
Uso gratuito: evaluación, desarrollo, pruebas, aprendizaje e investigación no comercial
Uso comercial: siempre bajo licencia o Cloud
Protección adicional: Trademark Policy + Partner Program
```

Didacta no debería copiar el modelo WordPress porque perdería demasiado control comercial.

Didacta puede inspirarse en n8n en la forma de comunicar el modelo, pero debería ser más estricto respecto al uso en producción y uso comercial.

La mejor vía es una licencia basada en BSL 1.1, redactada de forma sencilla, entendible y alineada con el negocio.

---

## 18. Próximos pasos

Antes de publicar el repositorio:

- validar el texto con un abogado especializado en software;
- definir la Change Date de la BSL;
- decidir la licencia futura tras la Change Date;
- registrar o proteger la marca Didacta;
- crear LICENSE, LICENSE_NOTICE.md y COMMERCIAL_USE.md;
- definir precios de licencia comercial;
- definir condiciones de Didacta Cloud;
- definir programa de partners;
- preparar una página pública de licencia;
- preparar un email de contacto comercial.

---

## 19. Aviso importante

Este documento es una propuesta estratégica y de producto.

No sustituye el asesoramiento legal profesional.

Antes de publicar Didacta bajo cualquier licencia, conviene revisar el texto definitivo con un abogado especializado en propiedad intelectual, software, licencias y SaaS.
