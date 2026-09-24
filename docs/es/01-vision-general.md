# Visión general

## Alcance V1 y V2

La misma entrada raíz y `/tui` carga de forma diferida el adaptador del host, conservando el ID `subagent-statusline.tui`. El soporte V1 sigue siendo `>=1.14.50 <2` (objetivos de validación: 1.14.50 y 1.18.29); el objetivo V2 es **2.0.11**, no cualquier versión V2. `/runtime` es experimental y exclusivo de V1.

V2 mantiene la sidebar, el resumen de inicio y los controles de la lista enfocada. Usa ejecuciones hijas públicas para mostrar **uso acumulado de entrada + salida**, metadatos opcionales de resumen/modelo y avisos de interrupción/frescura. No infiere ocupación del contexto ni lee SQLite/logs de V1. Los snapshots conservan formato y retención, con un subdirectorio `v2` por defecto. Consultá [instalación](02-instalacion-y-uso.md) para `cli.json` y el registro local por directorio.

El pipeline detallado de eventos/wrappers que sigue describe **V1**. La integración ahora está en `src/tui-v1.tsx` y la presentación compartida en `src/tui-view.tsx`; `src/tui.tsx` es solo el puente público diferido.

`opencode-subagent-statusline` es un plugin TUI para OpenCode que muestra actividad de subagentes dentro de la interfaz: subagentes corriendo, finalizados, fallidos, duración y uso de tokens/contexto cuando OpenCode expone esa información.

La idea central es simple:

> Cuando delegás trabajo a subagentes, el plugin mantiene visible qué está pasando sin obligarte a reconstruirlo desde eventos, logs o sesiones hijas.

## Qué problema resuelve

OpenCode puede ejecutar trabajo delegado en sesiones hijas o a través de herramientas como `task` y `delegate`. Eso es útil, pero genera una dificultad práctica: la actividad puede quedar repartida entre eventos de sesión, partes de mensajes y wrappers técnicos.

Sin una vista dedicada, es fácil perder respuestas a preguntas como:

- ¿Hay un subagente todavía corriendo?
- ¿Terminó bien o falló?
- ¿Cuál fue la sesión hija real?
- ¿Cuánto tiempo lleva?
- ¿Cuánto contexto usó?
- ¿Estoy viendo trabajo real o un wrapper técnico duplicado?

Este plugin junta esas señales y las convierte en una vista compacta para la TUI.

## Qué muestra

En la TUI, el plugin puede mostrar:

- subagentes en ejecución;
- subagentes terminados recientemente;
- subagentes con error;
- duración estimada;
- tokens y porcentaje de contexto cuando están disponibles;
- resumen agregado en la pantalla de inicio;
- navegación hacia la sesión hija real cuando existe un `sessionID` navegable.

## Las dos superficies públicas

El paquete publica dos entrypoints:

| Entrypoint                             | Fuente         | Uso principal                                                                            |
| -------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `opencode-subagent-statusline`         | `src/tui.tsx`  | Plugin TUI principal. Es el camino recomendado para usuarios.                            |
| `opencode-subagent-statusline/tui`     | `src/tui.tsx`  | Alias explícito del plugin TUI.                                                          |
| `opencode-subagent-statusline/runtime` | `src/index.ts` | Plugin runtime/file-based avanzado. Procesa eventos y escribe `state.json`/`status.txt`. |

El README actual se concentra en el modo TUI, que es la experiencia principal del paquete.

## Cómo funciona a alto nivel

El flujo general es este:

```txt
OpenCode event
  -> src/events.ts
  -> src/state.ts
  -> src/render.ts
  -> src/tui-v1.tsx (mediante el puente público) o src/index.ts
  -> sidebar / home footer / status.txt
```

Paso por paso:

1. **OpenCode emite eventos**
   - Por ejemplo: `session.created`, `session.status`, `message.part.updated`.

2. **El plugin extrae evidencia de subagentes**
   - `src/events.ts` interpreta eventos de sesión, subtareas y herramientas.

3. **El estado interno se actualiza**
   - `src/state.ts` guarda hijos, estados, tiempos, tokens y contadores.

4. **El render decide qué se ve**
   - `src/render.ts` colapsa duplicados, filtra filas antiguas y arma textos agregados.

5. **La TUI muestra la información**
   - `src/tui-v1.tsx` registra slots, comandos, navegación, hidratación y reconciliación de V1.

## Concepto clave: no todo evento es una ejecución real

Este es el punto más importante para entender el proyecto.

OpenCode puede representar el trabajo delegado de varias formas:

| Source interno | Qué representa                                            | Cuenta como ejecución          |
| -------------- | --------------------------------------------------------- | ------------------------------ |
| `session`      | Una sesión hija real de OpenCode.                         | Sí, una vez.                   |
| `subtask`      | Una subtarea sintética derivada de partes de mensaje.     | Puede contar provisionalmente. |
| `tool`         | Wrapper técnico de herramientas como `task` o `delegate`. | No.                            |

Por eso el plugin separa tres cosas:

1. **Estado almacenado**: todo lo que sabe el plugin.
2. **Filas visibles**: lo que conviene mostrar después de colapsar duplicados.
3. **Total ejecutado**: el conteo semántico de trabajo real.

Una fila visible no siempre equivale a una ejecución. Un wrapper `tool:*` puede aportar evidencia de estado, pero no debe inflar `totalExecuted`.

## Diseño defensivo

El plugin trabaja contra eventos que pueden variar según la versión de OpenCode, el tipo de delegación y el momento en que llega la información.

Por eso varias partes del diseño son conservadoras:

- si una correlación es ambigua, no se fuerza;
- si aparecen múltiples IDs posibles, no se adivina;
- si una sesión parece vieja pero no hay evidencia segura, no se cierra a ciegas;
- si falta información de tokens/contexto, se omite sin romper la UI;
- si falla una escritura auxiliar de estado/debug, el plugin intenta no romper OpenCode.

Esta estrategia aparece varias veces en el código y en los tests como comportamiento **fail-closed**.

## Qué está probado

El núcleo determinístico tiene buena cobertura de tests:

- parsing de eventos;
- transiciones de estado;
- contadores y deduplicación;
- render textual;
- reconciliación conservadora;
- comandos/keybindings básicos;
- persistencia del runtime plugin.

Los tests nativos cubren render compartido y ciclo de vida de los adaptadores. La interacción del paquete real se valida por separado en instancias OpenCode aisladas, fuera del CI unitario normal. La validación sintética no sustituye la aceptación de ejecución genuina en la TUI habitual del usuario.

## Dónde seguir

Para entender el código, seguí con:

- [Arquitectura](./03-arquitectura.md)
- `04-flujo-de-eventos.md` _(pendiente)_
- `05-modelo-de-estado-y-contadores.md` _(pendiente)_
- `06-renderizado-y-deduplicacion.md` _(pendiente)_
