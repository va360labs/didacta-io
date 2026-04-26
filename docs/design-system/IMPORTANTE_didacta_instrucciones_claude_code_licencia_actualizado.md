# Didacta — Preparación técnica del proyecto para modelo Source-Available / BSL 1.1

## Contexto del proyecto

Estamos desarrollando **Didacta**, un LMS moderno construido desde cero. Hasta ahora el proyecto se ha planteado como un **monolito**, pero queremos preparar la base técnica, documental y legal para un modelo de distribución **source-available**, inspirado en la **Business Source License 1.1 (BSL 1.1)**.

El objetivo no es convertir Didacta en un proyecto open source puro tipo WordPress, sino en un producto con código visible, comunidad, contribuciones y transparencia, pero con control sobre el uso comercial.

Didacta debe poder tener tres vías:

1. **Didacta Community**  
   Código visible para evaluación, aprendizaje, auditoría, pruebas, investigación y contribución.

2. **Didacta Enterprise / Commercial License**  
   Licencia comercial para empresas, academias, universidades, administraciones, consultoras, implantadores y cualquier uso en producción con usuarios reales.

3. **Didacta Cloud**  
   SaaS oficial gestionado por nosotros, con hosting, soporte, actualizaciones, backups, IA, seguridad y cumplimiento normativo.

---

## Objetivo técnico

Preparar el repositorio y el monolito para soportar correctamente este modelo de licencia.

Necesitamos que Claude Code revise el proyecto y proponga/aplique una estructura que permita:

- diferenciar claramente código Community, Enterprise y Cloud;
- dejar preparada la documentación legal básica;
- añadir avisos de licencia en el repositorio;
- evitar ambigüedad sobre usos comerciales;
- preparar el proyecto para futuras comprobaciones de licencia;
- evitar que alguien pueda reempaquetar Didacta como SaaS, white-label o LMS gestionado sin acuerdo;
- mantener una buena experiencia para desarrolladores y contribuidores.

---

## Principio de licencia

Didacta será **source-available**, no open source OSI.

La comunicación correcta debe ser:

> Didacta es un LMS source-available. Puedes ver el código, probarlo, auditarlo y contribuir. Para uso comercial, producción, organizaciones, alumnos reales, servicios gestionados o white-label necesitas una licencia comercial o usar Didacta Cloud.

No usar frases como:

- “Didacta es open source”
- “software libre”
- “uso libre para empresas”
- “free for commercial use”

Sí usar frases como:

- “source-available”
- “código disponible”
- “licencia comunitaria”
- “uso comercial bajo licencia”
- “Community Edition”
- “Enterprise License”
- “Didacta Cloud”

---

## Modelo recomendado

La licencia base será una variante de **BSL 1.1** adaptada a Didacta.

El modelo debe permitir:

### Permitido sin licencia comercial

- uso personal;
- uso local;
- evaluación;
- desarrollo;
- pruebas internas no productivas;
- investigación;
- auditoría;
- demos sin usuarios reales;
- contribución al proyecto;
- formación no comercial.

### Requiere licencia comercial o Didacta Cloud

- uso en producción;
- uso con alumnos reales;
- uso con empleados reales;
- uso con clientes reales;
- uso en academias, centros educativos, universidades, empresas o administraciones;
- venta de cursos usando Didacta;
- instalación para terceros;
- consultoría basada en Didacta;
- hosting gestionado;
- SaaS;
- white-label;
- reventa;
- sublicenciamiento;
- creación de un competidor cloud;
- cualquier uso donde Didacta forme parte de una actividad económica.

---

## Tareas para Claude Code

### 1. Revisar estructura actual del monolito

Analiza la estructura del proyecto actual y detecta:

- frameworks usados;
- carpetas principales;
- módulos internos;
- capa backend;
- capa frontend;
- capa de autenticación;
- capa de tenants/organizaciones, si existe;
- configuración de despliegue;
- scripts;
- documentación existente;
- archivos legales existentes;
- package managers;
- dependencias con licencias problemáticas.

Después, propone una estructura compatible con Community / Enterprise / Cloud.

---

### 2. Proponer estructura de carpetas

Si no existe ya, preparar una estructura similar a esta:

```txt
/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
│
├── packages/
│   ├── core/
│   ├── ui/
│   ├── auth/
│   ├── database/
│   ├── learning/
│   ├── community/
│   ├── ai/
│   └── licensing/
│
├── enterprise/
│   ├── README.md
│   └── .gitkeep
│
├── cloud/
│   ├── README.md
│   └── .gitkeep
│
├── docs/
│   ├── licensing/
│   ├── architecture/
│   ├── contributing/
│   └── deployment/
│
├── scripts/
├── tests/
├── LICENSE
├── LICENSE_NOTICE.md
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── CLAUDE.md
```

No aplicar esta estructura a ciegas si el proyecto ya usa otra arquitectura. Adaptarla de forma coherente.

---

### 3. Crear archivos legales/documentales mínimos

Crear o actualizar estos archivos:

```txt
LICENSE
LICENSE_NOTICE.md
README.md
CONTRIBUTING.md
SECURITY.md
docs/licensing/README.md
docs/licensing/commercial-use.md
docs/licensing/allowed-use.md
docs/licensing/faq.md
docs/licensing/third-party-licenses.md
```

---

## Contenido esperado de LICENSE

Crear un archivo `LICENSE` basado en BSL 1.1, pero con placeholders claros para revisión legal.

Debe incluir advertencia visible:

```md
This license draft is provided for product planning and engineering alignment purposes. It must be reviewed by qualified legal counsel before public release.
```

Debe dejar claro:

- Didacta no es open source OSI durante el periodo BSL;
- el código es source-available;
- el uso comercial requiere licencia;
- SaaS, managed hosting, white-label y uso en producción requieren acuerdo;
- habrá una fecha de cambio futura, si se decide mantener el patrón BSL clásico;
- indicar una licencia de cambio futura pendiente de decidir, por ejemplo GPLv3, AGPLv3 o Apache 2.0.

Importante: no inventar una licencia legal definitiva. Preparar una plantilla técnica con placeholders.

---

## Contenido esperado de LICENSE_NOTICE.md

Crear un documento claro y humano.

Texto base:

```md
# Didacta License Notice

Didacta is source-available software.

You may access, read, evaluate, test and contribute to the codebase under the terms of the Didacta Community License, based on the Business Source License 1.1.

Commercial use, production deployments, use with real students, customers, employees, organizations, public institutions, managed hosting, SaaS, resale, sublicensing or white-label usage requires a commercial agreement with Didacta or the use of Didacta Cloud.

Didacta is not open source under the OSI definition while distributed under this license.
```

---

## Contenido esperado de README.md

El README debe incluir una sección de licencia muy clara.

Ejemplo:

```md
## License

Didacta is distributed as source-available software under the Didacta Community License, based on the Business Source License 1.1.

You can use Didacta for learning, evaluation, local development, testing, research and non-commercial contribution.

Commercial use, production deployments, use with real users, SaaS, managed hosting, white-label, resale or use by organizations requires a commercial license or Didacta Cloud.

See [LICENSE](./LICENSE) and [LICENSE_NOTICE.md](./LICENSE_NOTICE.md).
```

---

## Contenido esperado de CONTRIBUTING.md

Debe explicar que aceptamos contribuciones, pero que al contribuir:

- el contribuidor acepta que su contribución se incluya en Didacta;
- la contribución se licencia bajo la licencia del proyecto;
- puede ser usada en Community, Enterprise y Cloud;
- no debe incluir código copiado de otros proyectos incompatibles;
- no debe incluir secretos, credenciales ni datos personales.

Incluir una advertencia:

```md
By contributing to Didacta, you agree that your contribution may be used, modified and distributed as part of Didacta Community, Didacta Enterprise and Didacta Cloud under the project's licensing model.
```

Más adelante puede valorarse un CLA formal.

---

## Contenido esperado de docs/licensing/commercial-use.md

Debe explicar con ejemplos qué requiere licencia comercial.

Casos que requieren licencia:

```md
- A private academy uses Didacta to sell courses.
- A company uses Didacta to train employees.
- A university uses Didacta with students.
- A public administration uses Didacta with citizens or staff.
- A consulting firm installs Didacta for a client.
- An agency offers Didacta as a managed LMS.
- A company rebrands Didacta as its own product.
- A provider offers Didacta as SaaS.
- A marketplace sells Didacta-based services.
```

---

## Contenido esperado de docs/licensing/allowed-use.md

Casos permitidos sin licencia comercial:

```md
- Running Didacta locally to evaluate it.
- Testing Didacta with fake/demo data.
- Reviewing the source code for security or architecture.
- Building a proof of concept without real users.
- Contributing a bug fix.
- Using Didacta in a classroom only as code study material, not as the production LMS.
- Researching LMS architecture.
```

---

## Contenido esperado de docs/licensing/faq.md

Preguntas mínimas:

```md
# Licensing FAQ

## Is Didacta open source?

No. Didacta is source-available. The code is visible and can be evaluated, tested and contributed to, but commercial use requires a license.

## Can I use Didacta in my company?

Only for evaluation, development and testing without real users. Production use requires a commercial license or Didacta Cloud.

## Can I use Didacta in an academy?

If it is used with real students, courses or customers, it requires a commercial license or Didacta Cloud.

## Can I offer Didacta as SaaS?

No, not without a written commercial agreement.

## Can I modify Didacta?

Yes, for evaluation, development and contribution under the license terms. Commercial use of modified versions also requires a commercial agreement.

## Can I create plugins?

Yes, but plugins must not be used to bypass licensing restrictions or create unauthorized commercial offerings.
```

---

## Separación Community / Enterprise / Cloud

Aunque ahora sea un monolito, preparar límites conceptuales.

### Community

Debe contener:

- LMS base;
- gestión básica de usuarios;
- cursos;
- lecciones;
- progreso;
- comunidad básica, si aplica;
- integraciones básicas;
- UI base;
- sistema base de permisos.

### Enterprise

Debe reservarse para:

- multi-tenant avanzado;
- SSO/SAML/OIDC avanzado;
- auditoría avanzada;
- logs legales;
- cumplimiento normativo avanzado;
- roles empresariales;
- reporting avanzado;
- integraciones corporativas;
- white-label autorizado;
- SLA/support hooks;
- controles de licencia;
- funciones premium de IA.

## Feature gating Community / Enterprise

Además de separar conceptualmente Community, Enterprise y Cloud, Didacta debe prepararse para que algunas funcionalidades estén presentes en el código o en la arquitectura, pero no sean accesibles sin una licencia válida de tipo Enterprise o Cloud.

El objetivo no es crear una experiencia hostil para el usuario, sino proteger claramente las capacidades comerciales avanzadas del producto.

### Principio general

Community debe ser usable para evaluación, desarrollo, aprendizaje y contribución. Sin embargo, determinadas funcionalidades de alto valor deben quedar bloqueadas o limitadas salvo licencia Enterprise, contrato comercial o uso de Didacta Cloud.

Ejemplos de funcionalidades candidatas a Enterprise:

- SSO/SAML/OIDC avanzado;
- multi-tenant real;
- white-label;
- dominios personalizados;
- informes avanzados;
- analítica avanzada de alumnos;
- exportaciones corporativas;
- logs de auditoría avanzados;
- roles y permisos empresariales;
- integraciones premium;
- automatizaciones avanzadas;
- funciones premium de IA;
- cumplimiento normativo avanzado;
- API avanzada;
- webhooks avanzados;
- soporte para grandes organizaciones;
- límites elevados de usuarios, cursos, organizaciones o almacenamiento.

### Comportamiento esperado

Cuando una funcionalidad no esté disponible en Community, la aplicación debe:

- ocultarla si no aporta valor mostrarla;
- mostrarla como bloqueada si ayuda a explicar el valor de Enterprise;
- evitar errores técnicos opacos;
- mostrar mensajes claros en el panel de administración;
- evitar que se pueda activar solo desde frontend;
- validar siempre en backend o capa de dominio;
- registrar intentos de acceso a features restringidas si procede.

Ejemplo de mensaje para UI:

```txt
This feature requires Didacta Enterprise or Didacta Cloud.
Contact Didacta to activate it for your organization.
```

Ejemplo de mensaje para documentación:

```md
Some advanced features are only available under a valid Enterprise license or in Didacta Cloud.
Community users can view, evaluate and contribute to the project, but Enterprise features require a commercial agreement.
```

### Requisito técnico importante

No confiar nunca únicamente en el frontend para bloquear funcionalidades Enterprise.

El control debe existir como mínimo en:

- backend;
- capa de servicios/dominio;
- API;
- workers o jobs en segundo plano;
- comandos CLI sensibles, si existen;
- endpoints de administración;
- sistema de permisos.

El frontend puede mejorar la experiencia visual, pero no debe ser la fuente de verdad de la licencia.

---

### Cloud

Debe reservarse para:

- billing;
- provisioning de tenants;
- monitorización;
- backups;
- escalado;
- límites por plan;
- gestión de suscripciones;
- infraestructura gestionada;
- observabilidad;
- panel interno de operaciones.

---

## Sistema de licencia interno

Preparar un paquete o módulo llamado `licensing`.

Objetivo inicial: no bloquear desarrollo, pero dejar una interfaz limpia, extensible y segura para activar o desactivar capacidades Community, Enterprise y Cloud.

Este módulo debe diseñarse como una pieza central del producto, no como un simple helper visual. Debe servir para:

- identificar el plan activo;
- validar licencias;
- controlar acceso a funcionalidades;
- definir límites de uso;
- proteger features Enterprise;
- mostrar avisos claros;
- facilitar futuras integraciones con billing, Cloud y contratos comerciales.

Ejemplo conceptual:

```ts
export type LicensePlan = 'community' | 'enterprise' | 'cloud';

export type LicenseStatus =
  | 'missing'
  | 'valid'
  | 'expired'
  | 'invalid'
  | 'grace_period'
  | 'development';

export interface LicenseContext {
  plan: LicensePlan;
  status: LicenseStatus;
  organizationId?: string;
  licenseId?: string;
  isProduction: boolean;
  enabledFeatures: string[];
  limits?: Record<string, number>;
}

export function hasFeature(context: LicenseContext, feature: string): boolean {
  return context.status === 'valid' && context.enabledFeatures.includes(feature);
}

export function requireFeature(context: LicenseContext, feature: string): void {
  if (!hasFeature(context, feature)) {
    throw new Error(`Feature "${feature}" requires a valid Enterprise or Cloud license.`);
  }
}
```

### Sistema seguro de licencias

Didacta debe preparar un sistema de licencias suficientemente seguro para producción, especialmente para instalaciones self-hosted con licencia Enterprise.

Requisitos esperados:

- licencias firmadas criptográficamente;
- validación local de la firma de licencia;
- evitar que la licencia sea un simple booleano editable en base de datos;
- incluir identificador de organización/cliente;
- incluir plan;
- incluir fecha de emisión;
- incluir fecha de expiración, si aplica;
- incluir features habilitadas;
- incluir límites de uso;
- incluir entorno permitido, si aplica;
- permitir validación offline razonable para clientes Enterprise;
- preparar validación online opcional para Cloud o contratos que lo requieran;
- registrar eventos relevantes de licencia;
- evitar exponer secretos privados en el repositorio;
- documentar claramente qué claves son públicas y cuáles nunca deben estar en el código.

La clave privada para firmar licencias nunca debe estar en el repositorio ni en el monolito. Solo debe vivir en sistemas internos de Didacta. El producto desplegado debe contener, como mucho, una clave pública o mecanismo equivalente para verificar licencias.

### Formato conceptual de licencia

Claude Code puede proponer un formato, pero no debe cerrar una implementación definitiva sin revisión.

Ejemplo conceptual:

```json
{
  "licenseId": "lic_123",
  "customerId": "cus_123",
  "organizationId": "org_123",
  "product": "didacta",
  "plan": "enterprise",
  "issuedAt": "2026-04-26T00:00:00Z",
  "expiresAt": "2027-04-26T00:00:00Z",
  "features": [
    "sso.saml",
    "white_label",
    "advanced_audit_logs",
    "advanced_reports",
    "custom_domains"
  ],
  "limits": {
    "users": 5000,
    "courses": 500,
    "storageGb": 1000
  }
}
```

Este payload debería firmarse con un mecanismo seguro. No guardar ni validar licencias como texto plano manipulable sin firma.

### Feature registry

Crear o preparar un registro centralizado de funcionalidades.

Ejemplo conceptual:

```ts
export const FEATURES = {
  SSO_SAML: 'sso.saml',
  WHITE_LABEL: 'white_label',
  CUSTOM_DOMAINS: 'custom_domains',
  ADVANCED_REPORTS: 'advanced_reports',
  ADVANCED_AUDIT_LOGS: 'advanced_audit_logs',
  AI_PREMIUM_TOOLS: 'ai.premium_tools',
  ENTERPRISE_ROLES: 'enterprise.roles',
} as const;
```

Evitar strings sueltos por toda la aplicación.

### Enforcement

El control de licencia debe aplicarse en varios niveles:

- rutas protegidas;
- controladores API;
- servicios de dominio;
- jobs/workers;
- comandos administrativos;
- creación de recursos;
- ejecución de integraciones premium;
- límites de uso.

Ejemplo conceptual:

```ts
await licensing.requireFeature(organizationId, FEATURES.SSO_SAML);
await ssoService.configureSamlProvider(input);
```

### Modo desarrollo

Debe existir un modo de desarrollo razonable para no frenar el trabajo del equipo.

Ejemplo:

- en local se pueden activar features Enterprise con una licencia de desarrollo;
- en tests se puede mockear el contexto de licencia;
- en producción no debe existir bypass simple;
- cualquier bypass debe estar limitado a `NODE_ENV !== 'production'`;
- los bypasses deben quedar documentados.

No implementar DRM agresivo todavía.

Sí preparar:

- feature flags;
- feature registry centralizado;
- comprobación de módulos enterprise;
- separación de configuración por plan;
- validación backend de features restringidas;
- estructura para licencias firmadas;
- avisos en UI/admin cuando el entorno parezca producción;
- telemetría opcional solo si cumple privacidad y normativa;
- tests unitarios para `hasFeature`, `requireFeature` y límites de uso.

---

## Señales de uso en producción

Preparar una función interna no invasiva para detectar señales de producción:

- `NODE_ENV=production`;
- dominio público configurado;
- más de X usuarios reales;
- emails reales;
- pagos activos;
- cursos publicados;
- alumnos inscritos;
- organización creada;
- integraciones activas;
- almacenamiento persistente configurado.

No bloquear automáticamente en esta fase, pero mostrar avisos administrativos.

Ejemplo de mensaje:

```txt
This instance appears to be used in a production or organizational context. Commercial use of Didacta requires a commercial license or Didacta Cloud.
```

---

## Dependencias de terceros

Revisar licencias de dependencias.

Objetivo:

- evitar dependencias GPL/AGPL si contaminan el proyecto;
- preferir MIT, Apache 2.0, BSD, ISC;
- documentar dependencias críticas;
- generar un inventario en `docs/licensing/third-party-licenses.md`.

Añadir script si procede:

```json
{
  "scripts": {
    "license:check": "license-checker --summary",
    "license:report": "license-checker --json > docs/licensing/third-party-licenses.json"
  }
}
```

Adaptar al package manager real.

---

## Archivos con cabecera de licencia

Añadir cabecera en archivos principales si procede.

Ejemplo:

```ts
/**
 * Copyright (c) Didacta.
 * This file is part of Didacta.
 *
 * Didacta is source-available software distributed under the Didacta Community License,
 * based on the Business Source License 1.1.
 * Commercial use requires a commercial agreement or Didacta Cloud.
 * See LICENSE and LICENSE_NOTICE.md for details.
 */
```

No hace falta meter cabecera en todos los archivos de golpe si genera demasiado ruido. Priorizar módulos principales.

---

## CLAUDE.md

Crear un archivo `CLAUDE.md` en la raíz para que Claude Code respete estas reglas.

Contenido sugerido:

```md
# Claude Code Instructions for Didacta

Didacta is a source-available LMS using a licensing model based on BSL 1.1.

Do not describe Didacta as open source unless explicitly discussing the difference between open source and source-available.

When adding new features, keep a clear separation between:

- Community features
- Enterprise features
- Cloud-only features

Do not add GPL/AGPL dependencies without explicit approval.

Prefer MIT, Apache 2.0, BSD or ISC dependencies.

Any feature involving SaaS, managed hosting, billing, white-label, enterprise compliance, SSO, advanced audit logs or multi-tenant provisioning should be treated as Enterprise or Cloud unless explicitly marked Community.

When modifying license-related files, preserve the source-available positioning and commercial-use restrictions.
```

---

## Resultado esperado

Al finalizar, el proyecto debe tener:

- estructura preparada para Community / Enterprise / Cloud;
- archivos de licencia y documentación inicial;
- README actualizado;
- CONTRIBUTING actualizado;
- SECURITY actualizado;
- documentación de usos permitidos y comerciales;
- módulo inicial de licensing o propuesta clara;
- feature registry Community / Enterprise / Cloud;
- propuesta de sistema seguro de licencias firmadas;
- puntos de enforcement en backend/API/dominio;
- revisión de dependencias;
- instrucciones para Claude Code;
- lista de TODOs técnicos y legales pendientes.

---

## No hacer todavía

No implementar todavía:

- bloqueo fuerte por licencia sin revisión de producto;
- activación remota obligatoria;
- llamadas externas de verificación obligatorias;
- DRM agresivo;
- claves privadas dentro del repositorio;
- bypasses de licencia utilizables en producción;
- cambios legales definitivos sin revisión profesional;
- eliminación de funcionalidades existentes;
- migraciones grandes sin plan previo.

---

## Entregable de Claude Code

Claude Code debe devolver:

1. resumen de la estructura actual detectada;
2. propuesta de cambios;
3. archivos creados/modificados;
4. riesgos encontrados;
5. dependencias con licencias problemáticas;
6. próximos pasos recomendados;
7. preguntas abiertas para decisión de producto/legal.

---

## Decisiones pendientes

Antes de publicar públicamente hay que decidir:

- nombre legal definitivo de la licencia: `Didacta Community License` u otro;
- entidad legal propietaria;
- jurisdicción;
- duración del periodo BSL;
- licencia de cambio futura: GPLv3, AGPLv3, Apache 2.0 u otra;
- política de contribuciones;
- si se requerirá CLA;
- qué features serán Community, Enterprise y Cloud;
- qué features Community estarán visibles pero bloqueadas sin Enterprise;
- formato final de licencia firmada;
- sistema interno para emitir licencias;
- política de expiración, renovación y periodo de gracia;
- pricing comercial;
- límites entre uso educativo no comercial y uso comercial.

---

## Nota final

Este documento no es asesoramiento legal. Es una guía técnica y de producto para preparar el repositorio y el monolito de Didacta antes de revisión legal formal.
