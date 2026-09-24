# Desarrollo y testing

Esta guía explica cómo preparar el proyecto localmente, qué comandos usar y cómo pensar los tests de `opencode-subagent-statusline`.

La regla práctica:

> El núcleo determinístico se prueba con Vitest. La UI completa dentro del host OpenCode/OpenTUI se valida con smoke tests manuales cuando hay cambios visuales.

## Requisitos

Usá el toolchain actual del paquete: **Node.js `>=22.13`**, **pnpm `11.2.2`** y el lockfile congelado. El job base de CI sigue en **22.13**. Los tests nativos de OpenTUI requieren además Node oficial **26.4.0** aislado; no cambia el mínimo del producto ni reemplaza tu runtime normal.

## Instalación local

Desde la raíz del repo:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

## Comandos principales

| Comando               | Para qué sirve                           |
| --------------------- | ---------------------------------------- |
| `pnpm build`          | Compila el paquete con `tsup`.           |
| `pnpm dev`            | Corre `tsup --watch`.                    |
| `pnpm typecheck`      | Ejecuta TypeScript sin emitir archivos.  |
| `pnpm test`           | Corre la suite Vitest una vez.           |
| `pnpm exec tsc --noEmit -p tsconfig.test.json` | Comprueba tipos de tests de source, fixtures y ambas configs Vitest, sin heredar la exclusión de tests. |
| `pnpm test:package` | Compila primero, empaqueta y analiza el grafo real de código/declaraciones. |
| `pnpm test:watch`     | Corre Vitest en modo watch.              |
| `pnpm test:coverage`  | Genera cobertura con V8.                 |
| `pnpm pack --dry-run` | Simula el paquete npm que se publicaría. |

Checklist recomendado antes de abrir PR:

```sh
pnpm typecheck
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm test
pnpm test:package
pnpm audit --prod --audit-level moderate
```

Si tocaste packaging o archivos publicados:

```sh
pnpm pack --dry-run
```

## Build

El build limpia `dist` una vez antes de las configuraciones de `tsup.config.ts` (cada una usa `clean:false`):

| Fuente         | Salida                  | Uso                        |
| -------------- | ----------------------- | -------------------------- |
| `src/tui.tsx` | `dist/tui.js` + tipos | Puente diferido sin bundle/runtime del host. |
| `src/tui-v1.tsx` | `dist/tui-v1.js` + tipos | Adaptador V1/vista compartida compilados. |
| `src/tui-v2.tsx` | `dist/tui-v2.js` + tipos | Adaptador V2/vista compartida compilados por separado. |
| `src/index.ts` | `dist/index.js` + tipos | Runtime experimental V1-only. |

API/tema, Solid y OpenTUI del host quedan como singletons externos. `@opencode/client` es solo de tipos. Los tests del paquete usan el parser TypeScript, comprueban targets diferidos/declaraciones, importan el puente sin dependencias del host y revisan metadata del build para detectar código del host incorporado o fallback V1 en V2. Los tests normales excluyen esa suite para no aceptar un `dist` viejo. Ambas configs usan `allowOnly: false`. El test de pack desactiva hooks con `--config.ignore-scripts=true` de pnpm 11; `prepack` sigue compilando explícitamente en un pack normal.

El paquete publica estos entrypoints:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
opencode-subagent-statusline/runtime
```

## TypeScript

Archivos relevantes:

| Archivo              | Rol                                                                               |
| -------------------- | --------------------------------------------------------------------------------- |
| `tsconfig.json`      | Config base del source. Usa NodeNext, ES2022, strict y JSX para `@opentui/solid`. |
| `tsconfig.test.json` | Config para tests, Vitest y archivos de setup.                                    |
| `tsup.config.ts`     | Config de build para runtime y TUI.                                               |

## Estrategia de tests

El proyecto usa Vitest.

Hay dos capas principales:

1. **Unit tests** para lógica determinística.
2. **Runtime integration tests** para filesystem y manejo de eventos estilo OpenCode.

Los tests nativos de vista/setup ejercitan OpenTUI cuando está disponible, pero no sustituyen la validación de interacción en hosts OpenCode reales.

## Lane nativo obligatorio y hosts reales

Node 22/24 normal omite únicamente los casos condicionados a la capacidad `node:ffi` cuando no existe; no dependas de un número fijo de skips mientras crece la suite. Seleccioná como `node` un binario oficial **26.4.0** aislado, comprobá FFI y activalo explícitamente en **padre y workers**:

```sh
node --experimental-ffi --input-type=module -e "await import('node:ffi')"
node --experimental-ffi node_modules/vitest/vitest.mjs run --execArgv=--experimental-ffi
```

El job nativo obligatorio de CI usa la misma suite Node/Vitest y rechaza tests pendientes/omitidos/todo mediante el reporter JSON. Node normal por sí solo no es validación nativa completa.

Instalá el mismo tarball en tres árboles aislados con `npm install --ignore-scripts --no-audit --no-fund` y resolución normal de peers (sin force/legacy-peer):

| Host real | Peers API/tema explícitos | Peers compartidos instalados |
| --- | --- | --- |
| V1 1.14.50 | `@opencode-ai/plugin@1.14.50` | core/solid `0.4.0`, Solid `1.9.12` |
| V1 1.18.29 | `@opencode-ai/plugin@1.18.29` | core/solid `0.4.5`, Solid `1.9.12` |
| V2 2.0.11 | `@opencode/plugin@2.0.11`, `@opencode/theme@2.0.11` | core/solid `0.5.10`, Solid `1.9.12` |

Core/solid significa `@opentui/core` y `@opentui/solid`. Los peers API/tema son alternativas opcionales: la API opuesta debe estar ausente, sin imponer tema V2 en V1. Los rangos publicados no anulan el peer Solid exacto de OpenTUI. V1 1.14.50 reemplaza módulos runtime por OpenTUI **0.2.9** / Solid **1.9.10**; el árbol instalado no valida por sí solo la vista compartida.

Usá HOME/config/data/cache/state/runtime nuevos, sin credenciales/servicios del usuario, y V2 `--standalone`. Registrá el directorio `dist` instalado en V2, no raíz/archivo. Registrá ruta/hash real del tarball, manifests, lockfiles y observaciones. Ejercitá navegación/vuelta al prompt/historial/selección/mouse/scroll/colapso/cleanup V1; V2 requiere además paleta real, prioridad Alt+B/Esc, escritura inmediata al volver al padre, exclusión modal/modificadores, resize y unload/reload. Enviá Enter solo con foco confirmado en lista/paleta y detené solo grupos de procesos propios. Identificá los datos sintéticos; la aceptación de ejecución genuina en la TUI habitual es aparte. Lo no probado sigue pendiente, sin elevar el mínimo V1 ni prometer cualquier V2.

La evidencia de cleanup combina desactivación pública del plugin/eliminación de config con el host vivo, una observación acotada de actividad en snapshots/contribuciones tras modificar metadatos propios y tests nativos de ownership. Terminar el proceso del host no demuestra cleanup del plugin. Intentá por separado la salida pública del host y declará cualquier terminación forzada. Demostrá desplazamiento de la rueda desde una posición no saturada, no solo el envío del evento.

## Mapa de tests

| Archivo                           | Qué valida                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `src/events.test.ts`              | Parsing de eventos, extracción de IDs, correlación y tolerancia a payloads malformados. |
| `src/state.test.ts`               | Estado, contadores, transiciones, poda, persistencia y normalización.                   |
| `src/render.test.ts`              | Render textual, collapse, visibilidad, duración, tokens y color/no-color.               |
| `src/reconcile.test.ts`           | Normalización de estados, stale-running, backoff y fail-closed.                         |
| `src/text-width.test.ts`          | Ancho de columnas para texto CJK/full-width, marcas combinantes y truncado.              |
| `src/tui.test.ts`                 | Registro de comandos, keybinding `Alt+B` y fallback legacy.                             |
| `src/tui-entry.test.ts`, `test/package.integration.test.ts` | Selección diferida del host y grafos reales de código/declaraciones empaquetados. |
| `src/tui-view.test.ts`, `test/tui-v1-lifecycle.integration.test.ts` | Render/scroll compartidos y ownership nativo de slot/foco/cleanup V1. |
| `src/tui-v2-state.test.ts`, `src/tui-v2-snapshot.test.ts`, `src/tui-v2-focus.test.ts` | Frescura V2, persistencia serializada y ownership público del foco. |
| `test/tui-v2.integration.test.ts` | Setup V2 nativo, despacho de teclas, slots, preferencias y disposal. |
| `test/index.integration.test.ts`  | Plugin runtime, `state.json`, `status.txt`, preserve-state y errores de filesystem.     |
| `test/helpers/runtime-harness.ts` | Helpers para temp dirs, fixtures, env vars y fake time.                                 |
| `test/setup.ts`                   | Limpieza global de timers, mocks, env vars y temp dirs.                                 |

## Coverage

La cobertura se configura en `vitest.config.ts`:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/tui.tsx"],
}
```

Punto importante:

> Coverage incluye `.ts`, no `.tsx`; el puente también tiene una exclusión explícita. Los tests nativos de comportamiento son independientes del cálculo de cobertura. Ni un porcentaje de coverage ni una suite de source verde certifican toda la TUI del host real.

La cobertura actual se enfoca en módulos `.ts` determinísticos: eventos, estado, render, reconcile, helpers de ancho textual, comandos y runtime.

## Patrón Arrange / Act / Assert

Los tests deberían seguir esta estructura:

```ts
it("persists a supported event", async () => {
  // Arrange
  const harness = await createRuntimeHarness();
  const plugin = await SubagentStatusline(
    {} as Parameters<typeof SubagentStatusline>[0],
  );
  const event = await readJsonFixture("session-created");

  // Act
  await plugin.event?.({ event } as never);

  // Assert
  const state = await readRuntimeState(harness.statePath);
  expect(state.children.ses_child_1.status).toBe("running");
});
```

Preferí asserts semánticos antes que snapshots grandes.

Bueno:

```ts
expect(output).toContain("1 running");
expect(output).toContain("Review auth changes");
```

Más frágil:

```ts
expect(output).toMatchSnapshot();
```

## Cómo agregar un unit test

1. Identificá el comportamiento a proteger.
2. Elegí el archivo co-localizado:
   - `src/events.test.ts`
   - `src/state.test.ts`
   - `src/render.test.ts`
   - `src/reconcile.test.ts`
   - `src/tui.test.ts`
3. Armá inputs mínimos.
4. Ejecutá la función pública o helper bajo test.
5. Afirmá comportamiento visible, no detalles accidentales.

Ejemplo conceptual:

```ts
it("does not count tool wrappers", () => {
  const state = createEmptyState();

  upsertRunningChild(state, {
    id: "tool:prt_1",
    source: "tool",
  });

  expect(state.totalExecuted).toBe(0);
});
```

## Cómo agregar un integration test runtime

Los integration tests viven en `test/**/*.integration.test.ts`.

Usá el harness para aislar filesystem y env vars:

```ts
it("writes runtime output after an event", async () => {
  const harness = await createRuntimeHarness();
  const plugin = await SubagentStatusline(
    {} as Parameters<typeof SubagentStatusline>[0],
  );
  const event = await readJsonFixture("session-created");

  await plugin.event?.({ event } as never);

  expect(await readStatusText(harness.textPath)).toContain(
    "Review auth changes",
  );
});
```

Helpers útiles:

| Helper                   | Uso                                                 |
| ------------------------ | --------------------------------------------------- |
| `createRuntimeHarness()` | Crea temp dir y configura estado aislado.           |
| `readJsonFixture(name)`  | Lee fixtures de `test/fixtures/events/<name>.json`. |
| `readRuntimeState(path)` | Lee `state.json`.                                   |
| `readStatusText(path)`   | Lee `status.txt`.                                   |
| `pathExists(path)`       | Verifica existencia sin throw.                      |
| `useFrozenTime(iso)`     | Congela tiempo con fake timers.                     |

## Fixtures

Los fixtures viven en:

```txt
test/fixtures/events/
```

Usalos cuando un payload se reutiliza o cuando conviene documentar una forma conocida de evento OpenCode.

Mantenelos chicos y representativos. No metas dumps enormes salvo que el tamaño sea parte del comportamiento a proteger.

## Fake timers

Si un test depende del tiempo:

- congelá explícitamente el tiempo en Arrange;
- evitá estado global compartido;
- dejá que `test/setup.ts` restaure timers reales después del test.

Ejemplo:

```ts
useFrozenTime("2026-01-01T00:00:00.000Z");
```

## Variables de entorno en tests

`test/setup.ts` restaura env vars del plugin después de cada test.

Si agregás una nueva variable que los tests modifican, agregala a la lista de cleanup en `test/setup.ts`.

## Límites entre unit tests y hosts reales

Evitá snapshots visuales amplios o un host OpenCode simulado en unit tests. Mantené las pruebas de navegación/interacción del paquete real en el procedimiento aislado anterior, fuera del CI unitario normal.

Para cambios de UI real, preferí:

1. tests unitarios para lógica extraíble;
2. tests de comandos si cambia keybinding/registro;
3. tests nativos de ciclo de vida/entrada y validación en hosts OpenCode reales.

## Smoke test manual TUI V1

Cuando tocás `src/tui-v1.tsx`, `src/tui-view.tsx`, `src/render.ts` o comportamiento visible V1:

1. Compilá:

   ```sh
   pnpm build
   ```

2. Configurá OpenCode con ruta absoluta:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
   }
   ```

3. Reiniciá OpenCode.
4. Ejecutá una delegación/subagente.
5. Verificá sidebar, estados y duración.
6. Probá `Alt+B`, `j/k`, flechas, `Enter` y `Esc`.
7. Si hay tokens/contexto, confirmá que se muestran sin romper la fila.
8. Revisá logs si el plugin no carga.

## CI

El workflow de PR está en `.github/workflows/ci.yml`.

Corre:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm test:package
pnpm audit --prod --audit-level moderate
pnpm pack --dry-run
```

El job separado Node 26.4.0 comprueba FFI, corre toda la suite de source con ambos flags y exige cero skips. La validación interactiva en hosts reales es aparte; no agregues llamadas a modelos con credenciales a los tests unitarios.

## Buenas prácticas de contribución

Según `CONTRIBUTING.md`:

- preferí issue-first para cambios no triviales;
- mantené PRs chicos y revisables;
- usá Conventional Commits;
- nunca commitees secretos;
- explicá qué cambió, por qué y cómo lo validaste.

Ejemplos de commits:

```txt
feat: add runtime summary grouping
fix: handle missing token metadata
docs: clarify local setup
```

## Checklist rápido por tipo de cambio

| Cambio                | Validación mínima recomendada                |
| --------------------- | -------------------------------------------- |
| Solo docs             | Revisar links y formato Markdown.            |
| Eventos/estado/render | `pnpm test`, tests focalizados.              |
| TypeScript/API        | `pnpm typecheck`, `pnpm test`.               |
| TUI visual            | `pnpm build`, smoke test manual en OpenCode. |
| Packaging             | `pnpm build`, `pnpm pack --dry-run`.         |
| CI/release            | Revisar workflows y documentar impacto.      |
