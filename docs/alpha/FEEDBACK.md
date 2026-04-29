# Cómo reportar feedback — Alpha de Didacta

> Eres parte de un grupo cerrado de testers. Tu feedback es **el activo más valioso** del proyecto en esta fase. Abajo cómo hacerlo llegar.

## Cómo elegir el tipo de reporte

| Situación | Plantilla a usar |
|-----------|------------------|
| Algo se rompe / no funciona como debería | 🐛 **Bug report** |
| Algo funciona pero no me gusta cómo / es confuso | 💬 **Feedback** |
| Quiero pedir una feature nueva | ✨ **Feature request** |
| Quiero hacer una pregunta / pedir ayuda | 💡 **Discussion** (en GitHub Discussions del repo) |
| Es urgente / afecta seguridad | Email directo a `security@didacta.io` |

## Workflow

1. Ve al repo: https://github.com/va360labs/didacta-community/issues/new/choose
2. Elige el template que corresponda.
3. Rellena los campos. **Cuanto más concreto, mejor**.
4. Etiqueta automáticamente lleva `alpha-tester`.
5. Confirma — quedará visible para nosotros y el resto del grupo.

## Guía de cómo reportar bugs útiles

### ✅ Bug bien reportado

> **Título**: "Crear curso desde panel admin falla con error 500"
>
> **Pasos para reproducir**:
> 1. Ir a `/admin/courses/new`.
> 2. Rellenar título, descripción, categoría.
> 3. Click "Crear".
>
> **Esperado**: curso creado.
>
> **Real**: respuesta 500. En logs `didacta`:
> `TypeError: Cannot read properties of undefined (reading 'tenantId')`.
>
> **Versión**: `0.0.1-alpha.0`.
> **Navegador**: Chrome 120.
> **OS**: Mac M1.

### ❌ Bug poco útil

> "No me funciona"

(Imposible reproducir sin contexto.)

## Cosa que SÍ queremos saber en esta alpha

- Cosas que rompen.
- Cosas que confunden o que tardas en encontrar.
- Cosas que esperabas y no están.
- Mensajes de error que no entiendes.
- Performance lenta en alguna pantalla.
- Documentación que falta o está mal.
- Decisiones de licencing / EE / Cloud god que no quedan claras.

## Cosa que NO necesitamos en esta alpha

- Diseño del frontend (estamos centrados en backend + arquitectura).
- Features que sabemos que faltan (ej. SCIM, multi-tenant real, marketplace).
- Comparaciones con Moodle / LearnDash / TalentLMS.

## Sesión semanal "office hour"

Una vez por semana (jueves 18:00 CET), 30 min en Discord. Vienes con tus dudas y las resolvemos en directo. Es opcional.

## Privacidad

- Nada de lo que reportes (logs, screenshots, datos de prueba) sale del grupo de alpha testers.
- Si nos mandas datos personales por error en un log, los borramos. Mejor anonimízalos antes.
- Tienes derecho a borrar tu cuenta del repo y de Discord cuando quieras.

## Reconocimiento

Los testers que reporten contribuciones útiles aparecen (con su consentimiento) en `CONTRIBUTORS.md` cuando hagamos público el repo en v1.0.0.

## Contacto

- **Discord/Slack** `#didacta-alpha` — para conversación rápida.
- **GitHub Issues** del repo — para reportes formales.
- **`alpha@didacta.io`** — para temas privados o que no quieres compartir con el grupo.

¡Gracias por estar aquí! 🚀
