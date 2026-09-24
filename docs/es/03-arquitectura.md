# Arquitectura

## Entrada dual y vista compartida

```txt
raíz / tui -> dist/tui.js (src/tui.tsx, sin runtime del host incorporado)
  tui(api, options, meta) -> carga diferida tui-v1.js -> eventos/fallback V1
  setup(context)         -> carga diferida tui-v2.js -> ejecuciones/cache públicos V2
                              ambos -> tui-view.tsx + helpers state/render
runtime -> dist/index.js (experimental, exclusivo de V1)
```

El puente nunca prueba el otro host si falla la inicialización. Los adaptadores se compilan por separado y dejan externos la API, tema, Solid y OpenTUI del host. `@opencode/client` solo aporta tipos. El build limpia una vez antes de las configuraciones paralelas y empaqueta todas las referencias relativas de código/tipos. Cada setup V2 posee foco, generaciones de lecturas y snapshots serializados; cleanup invalida trabajo pendiente y espera al escritor. Se mapean ocho roles de tema, con `backgroundPanel` y `backgroundElement` distintos; storage guarda solo `{ enabled, expanded }`.

El pipeline y los detalles siguientes describen **V1**, ahora en `src/tui-v1.tsx` con presentación compartida en `src/tui-view.tsx`.

El plugin está organizado alrededor de un pipeline: recibir eventos de OpenCode, normalizarlos como estado interno, deduplicar representaciones técnicas y renderizar una vista útil para la TUI.

```txt
OpenCode
  ├─ eventos de sesión
  ├─ eventos de mensaje
  └─ eventos de partes/tool calls
        ↓
src/events.ts
        ↓
src/state.ts
        ↓
src/render.ts
        ↓
┌──────────────────────┬──────────────────────┐
│ src/tui-v1.tsx       │ src/index.ts          │
│ Plugin TUI principal │ Plugin runtime        │
│ Sidebar / footer     │ state.json/status.txt │
└──────────────────────┴──────────────────────┘
```

## Mapa de módulos

| Archivo                          | Responsabilidad                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/tui.tsx` | Puente público diferido sin runtime del host. |
| `src/tui-v1.tsx` | Slots, hidratación, fallback, navegación y ciclo de vida V1. |
| `src/tui-v2.tsx` | Slots, datos tipados, keymap/foco y cleanup propio V2. |
| `src/tui-view.tsx` | Presentación sidebar/inicio y controlador compartidos. |
| `src/index.ts`                   | Plugin runtime/file-based: escucha eventos, persiste estado y escribe `status.txt`.                    |
| `src/events.ts`                  | Convierte eventos de OpenCode en mutaciones del estado interno.                                        |
| `src/state.ts`                   | Define el modelo de datos, contadores, persistencia y helpers de mutación.                             |
| `src/render.ts`                  | Formatea filas, colapsa duplicados, filtra visibilidad y arma el statusline textual.                   |
| `src/reconcile.ts`               | Normaliza estados de OpenCode y ayuda a cerrar casos `running` viejos de forma segura.                 |
| `src/tui-commands.ts`            | Registra comandos y keybindings, especialmente `Alt+B`.                                                |
| `src/*.test.ts`                  | Tests unitarios del núcleo determinístico.                                                             |
| `test/index.integration.test.ts` | Tests de integración del plugin runtime y persistencia en filesystem.                                  |

## Entrypoints

### TUI plugin

Fuente pública: `src/tui.tsx`; las responsabilidades legacy siguientes pertenecen a `src/tui-v1.tsx` y la vista compartida `src/tui-view.tsx`, no al puente.

Es el entrypoint principal del paquete:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

Responsabilidades principales:

- registrar el plugin TUI con id `subagent-statusline.tui`;
- montar la UI con Solid/OpenTUI;
- escuchar eventos relevantes de OpenCode;
- renderizar la sidebar de subagentes;
- renderizar un resumen inferior en home;
- registrar comandos y atajos;
- hidratar subagentes existentes al navegar entre sesiones;
- reconciliar estados viejos que quedaron como `running`;
- persistir snapshots auxiliares de estado.

### Runtime plugin

Fuente: `src/index.ts`

Se publica como:

```txt
opencode-subagent-statusline/runtime
```

Este modo es más bajo nivel. No renderiza la sidebar TUI. En cambio:

1. inicializa rutas de estado;
2. procesa eventos;
3. guarda `state.json`;
4. escribe `status.txt` con el render textual.

Es útil para entender el núcleo V1 del proyecto porque usa el mismo pipeline de eventos, estado y renderizado, pero sin la capa visual de `src/tui-view.tsx`.

## Modelo interno

El estado central vive en `src/state.ts`.

De forma simplificada:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>;
  countedChildIDs: string[];
  totalExecuted: number;
  updatedAt: string;
};
```

Cada child representa una pieza de trabajo relacionada con subagentes:

```ts
type ChildSessionState = {
  id: string;
  parentID?: string;
  targetSessionID?: string;
  source?: "session" | "subtask" | "tool";
  status: "running" | "done" | "error";
  title?: string;
  summary?: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string;
  tokenState?: ChildTokenState;
};
```

La documentación completa del modelo va en `05-modelo-de-estado-y-contadores.md`, pero la regla base es:

> El estado guarda evidencia. El render decide qué se muestra. El contador decide qué fue ejecución real.

## Sources: session, subtask y tool

El plugin necesita distinguir de dónde viene cada work item.

| Source    | Origen típico                                             | Uso                                                        |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `session` | Eventos `session.*` de OpenCode con una sesión hija real. | Es la fuente más fuerte. Cuenta como ejecución real.       |
| `subtask` | Partes de mensaje que describen una subtarea.             | Sirve como fallback temprano o provisional.                |
| `tool`    | Tool calls como `task` o `delegate`.                      | Aporta evidencia de estado, pero no cuenta como ejecución. |

Esta separación existe porque OpenCode puede avisar primero sobre un wrapper técnico y después revelar la sesión real, o puede emitir información incompleta en distintos eventos.

## Pipeline de eventos

`src/events.ts` recibe eventos de OpenCode y decide si hay algo relevante para el estado.

Eventos principales:

| Evento                 | Qué puede significar                                      |
| ---------------------- | --------------------------------------------------------- |
| `session.created`      | Apareció una sesión hija real.                            |
| `session.updated`      | Cambió información de una sesión.                         |
| `session.status`       | Cambió el estado normalizado de una sesión.               |
| `session.idle`         | La sesión quedó inactiva, normalmente `done`.             |
| `session.error`        | La sesión falló.                                          |
| `message.updated`      | Puede traer evidencia de finalización de subtareas.       |
| `message.part.updated` | Puede representar subtareas o wrappers `task`/`delegate`. |

El objetivo de `events.ts` no es renderizar. Su trabajo es transformar señales variables en mutaciones consistentes sobre `StatuslineState`.

## Estado y contadores

`src/state.ts` concentra las invariantes importantes:

- crear o actualizar hijos corriendo;
- marcar hijos como `done` o `error`;
- mezclar detalles como título, resumen, agente y tokens;
- refrescar duración y campos derivados;
- persistir y cargar estado;
- podar hijos terminales viejos;
- mantener `totalExecuted` sin duplicados.

Reglas críticas:

- los wrappers `source: "tool"` no incrementan contadores;
- las sesiones reales cuentan una sola vez;
- los subtasks pueden contar como fallback;
- si luego aparece una sesión real, el conteo se reconcilia hacia esa sesión;
- el estado cargado desde disco se normaliza para evitar identidades duplicadas.

## Renderizado

`src/render.ts` no imprime simplemente `state.children`.

Antes de mostrar algo:

1. ordena por prioridad/recencia;
2. colapsa duplicados;
3. fusiona datos útiles de sesión real hacia filas sintéticas cuando corresponde;
4. filtra `done` viejos;
5. conserva errores y running visibles;
6. arma el resumen agregado.

Esto explica por qué puede haber más children en el estado que filas visibles en la UI.

## TUI runtime

`src/tui-v1.tsx` reúne la integración legacy; la presentación compartida está en `src/tui-view.tsx`.

Responsabilidades principales:

### 1. Inicialización

Crea estado en memoria, registra comandos, prepara slots y configura listeners de eventos.

### 2. Slots visuales

Registra contenido para:

- `sidebar_content`;
- `home_bottom`;
- `home_prompt`;
- `session_prompt`.

Los slots de prompt se usan para preservar referencias de foco y compatibilidad con distintas formas de props de OpenCode.

### 3. Sidebar

La sidebar muestra solo subagentes relacionados con la sesión actual. El resumen de home y el render textual/status-file siguen siendo globales entre sesiones.

Soporta:

- expandir/colapsar;
- habilitar/deshabilitar sección;
- scroll;
- foco con teclado;
- navegación con `j/k` y flechas;
- abrir una sesión hija con `Enter` o click cuando hay `targetSessionID` navegable.

### 4. Hydration

Cuando se navega a una sesión, el plugin intenta reconstruir subagentes previos consultando APIs de OpenCode como sesiones hijas, mensajes y estados.

Esto permite que la UI no dependa solamente de eventos vistos en vivo desde que cargó el plugin.

### 5. Reconciliación

Un intervalo revisa subagentes que quedaron `running` durante mucho tiempo.

La reconciliación no cierra todo por timeout. Primero busca evidencia en estado TUI, estado de sesión y mensajes. Si no hay evidencia suficiente, se comporta de forma conservadora.

### 6. Tokens/contexto

La hidratación de tokens es best-effort. Puede venir de:

- payloads de eventos;
- estado vivo de la TUI;
- base SQLite de OpenCode;
- logs recientes.

Si no se consigue información, la UI sigue funcionando sin mostrar esos datos.

## Reconciliación de estados

`src/reconcile.ts` contiene helpers para interpretar estados de OpenCode y evitar cierres inseguros.

Ejemplos:

| OpenCode                                                                 | Estado interno |
| ------------------------------------------------------------------------ | -------------- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running`      |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded`          | `done`         |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted`         | `error`        |

Si el estado es desconocido, se considera inconcluso en vez de adivinar.

## Comandos y keybindings

`src/tui-commands.ts` registra comandos de TUI.

Comandos principales:

| Comando                             | Acción                                       |
| ----------------------------------- | -------------------------------------------- |
| `Subagents: Toggle sidebar section` | Activa o desactiva la sección de subagentes. |
| `Subagents: Focus sidebar list`     | Mueve el foco a la lista de subagentes.      |
| `Subagents: Toggle completed history` | Alterna filas completadas retenidas en la sidebar. |

Atajo principal:

```txt
Alt+B
```

Si la API moderna de keymap está disponible, el plugin la usa. Si no, cae al sistema legacy de comandos.

## Testing como contrato de arquitectura

Los tests no son solo verificación; también documentan decisiones de diseño.

| Test                             | Qué protege                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `src/events.test.ts`             | Parsing de eventos, correlación y fail-closed en ambigüedad. |
| `src/state.test.ts`              | Contadores, persistencia, normalización y reglas de sources. |
| `src/render.test.ts`             | Collapse, visibilidad, formato y resumen agregado.           |
| `src/reconcile.test.ts`          | Normalización de estados y reconciliación conservadora.      |
| `src/tui.test.ts`                | Registro de comandos/keybindings.                            |
| `test/index.integration.test.ts` | Runtime plugin, archivos de estado y tolerancia a errores.   |

Límite de validación: los tests nativos ejercitan la vista compartida y el ciclo de vida de los adaptadores, incluido el ownership del slot V1. Carga del paquete, prioridad de teclado, navegación y cleanup se validan por separado en hosts reales; los tests de source no bastan para demostrar compatibilidad.

## Archivos de configuración relevantes

| Archivo                         | Rol                                                             |
| ------------------------------- | --------------------------------------------------------------- |
| `package.json`                  | Nombre del paquete, exports, scripts, peers y metadatos de release. |
| `tsup.config.ts`                | Build dual: runtime y TUI.                                      |
| `tsconfig.json`                 | TypeScript base para source.                                    |
| `tsconfig.test.json`            | TypeScript para tests.                                          |
| `vitest.config.ts`              | Vitest, coverage y setup.                                       |
| `.github/workflows/ci.yml`      | CI de PR y push a `main`: typecheck, tests, audit y paquete.    |
| `.github/workflows/release.yml` | Publicación por tag estable y notas de GitHub Release.          |

## Decisiones de diseño importantes

1. **El plugin prioriza no romper OpenCode**
   - Muchas operaciones auxiliares son best-effort.

2. **La correlación ambigua no se fuerza**
   - Si no hay una relación segura entre wrapper, subtask y sesión, no se inventa.

3. **El contador es semántico**
   - Cuenta trabajo real, no cantidad de filas ni cantidad de eventos.

4. **La TUI hidrata información histórica**
   - No depende únicamente de eventos live.

5. **Los tokens/contexto son opcionales**
   - Se muestran cuando hay evidencia disponible.

## Siguiente lectura

Para profundizar, seguí con:

- `04-flujo-de-eventos.md` _(pendiente)_
- `05-modelo-de-estado-y-contadores.md` _(pendiente)_
- `06-renderizado-y-deduplicacion.md` _(pendiente)_
