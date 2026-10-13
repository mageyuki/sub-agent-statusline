# Documentación en español

Esta carpeta explica cómo funciona `@mageyuki/opencode-subagent-statusline`: qué problema resuelve, cómo se integra con OpenCode, cómo procesa eventos de subagentes y cómo se mantiene el proyecto.

La documentación está pensada para dos públicos:

- **Usuarios del plugin**, que quieren instalarlo, configurarlo y entender qué están viendo en la TUI.
- **Contribuidores**, que necesitan entender la arquitectura, los tests y las reglas internas antes de cambiar código.

## Lectura recomendada

Si es tu primera vez en el repo, seguí este orden:

1. [Visión general](./01-vision-general.md)
2. [Instalación y uso](./02-instalacion-y-uso.md)
3. [Arquitectura](./03-arquitectura.md)
4. [Flujo de eventos](./04-flujo-de-eventos.md)
5. [Modelo de estado y contadores](./05-modelo-de-estado-y-contadores.md)
6. [Renderizado y deduplicación](./06-renderizado-y-deduplicacion.md)
7. [Interfaz TUI](./07-interfaz-tui.md)
8. [Configuración avanzada](./08-configuracion-avanzada.md)
9. [Desarrollo y testing](./09-desarrollo-y-testing.md)
10. [Solución de problemas](./10-solucion-de-problemas.md)

## Mapa rápido

| Documento | Para qué sirve |
| --- | --- |
| [01-vision-general.md](./01-vision-general.md) | Entender qué hace el plugin y cuáles son sus piezas principales. |
| [02-instalacion-y-uso.md](./02-instalacion-y-uso.md) | Instalar el plugin en OpenCode y usar la sidebar. |
| [03-arquitectura.md](./03-arquitectura.md) | Entender los módulos del código y cómo se conectan. |
| [04-flujo-de-eventos.md](./04-flujo-de-eventos.md) | Seguir el camino desde un evento de OpenCode hasta una fila visible. |
| [05-modelo-de-estado-y-contadores.md](./05-modelo-de-estado-y-contadores.md) | Explicar `StatuslineState`, `ChildSessionState`, sources y `totalExecuted`. |
| [06-renderizado-y-deduplicacion.md](./06-renderizado-y-deduplicacion.md) | Explicar collapse de filas, visibilidad y diferencias entre estado interno y UI. |
| [07-interfaz-tui.md](./07-interfaz-tui.md) | Documentar sidebar, footer, navegación y comandos. |
| [08-configuracion-avanzada.md](./08-configuracion-avanzada.md) | Variables de entorno, archivos de estado, debug y rutas. |
| [09-desarrollo-y-testing.md](./09-desarrollo-y-testing.md) | Comandos, estrategia de tests, límites de cobertura y smoke tests. |
| [10-solucion-de-problemas.md](./10-solucion-de-problemas.md) | Casos comunes: plugin no aparece, cache vieja, tokens faltantes, etc. |

## Estado de esta documentación

Documentos creados:

- `00-indice.md`
- `01-vision-general.md`
- `02-instalacion-y-uso.md`
- `03-arquitectura.md`
- `04-flujo-de-eventos.md`
- `05-modelo-de-estado-y-contadores.md`
- `06-renderizado-y-deduplicacion.md`
- `07-interfaz-tui.md`
- `08-configuracion-avanzada.md`
- `09-desarrollo-y-testing.md`
- `10-solucion-de-problemas.md`

No forma parte de la numeración actual:

- publicación y release, que queda como tema pendiente si se decide documentarlo después.
