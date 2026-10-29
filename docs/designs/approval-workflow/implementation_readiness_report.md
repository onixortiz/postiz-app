# Etapa 9: prueba de preparación para implementar (ronda 1)

*   **Documento:** `docs/designs/approval-workflow.md`, DetailedRange (líneas
    1344 a 2370).
*   **Revisores:** ninguno tuvo acceso a la conversación.

    | Revisor | Estándar | Estado | Hallazgos |
    |---|---|---|---|
    | `egm-implementation-readiness` | `implementation-readiness-standard` | completado | 2 Blocker, 24 Major, 9 Nit |
    | `egm-codebase-details` | `implementation-readiness-standard` | completado | 3 Blocker, 27 Major, 6 Nit |
    | `egm-style` | solo su persona | completado | 9 Major, 14 Nit |

*   **Fecha:** 2026-10-28

**Veredicto: el plan todavía no se puede ejecutar sin tomar decisiones de
diseño.** Al consolidar los tres informes quedan 5 Blocker y unos 30 Major.

**Comprobado por el Elephant en el código:**

*   `package.json` no tiene script `lint`.
*   `comments.components.tsx:194-197` es un `fetch` con POST, no una clave de
    SWR.
*   `posts.repository.ts:573-576` pone en `QUEUE` cualquier post que no esté en
    `DRAFT` cuando se llama con `action = 'schedule'`.

## 🔴 Blockers

| # | Problema | Arreglo | Origen |
|---|---|---|---|
| B1 | `decideBatch` devuelve un solo `type` para todo el cuerpo, pero un canal en `PUBLISHED` tiene que guardarse con `update`. Así, un lote que mezcla canales publicados y sin publicar no se puede programar. | Agregar `typeByIntegration` a la salida. El bucle y la condición que inicia el workflow lo leen por canal. Los canales en `PUBLISHED` no pasan por la validación de fecha pasada. | IR-B1, Style-M2 |
| B2 | La tarea de mantenimiento no se apaga con `APPROVALS_ENABLED=false`. En una vuelta atrás, seguiría pasando a `DRAFT` todos los posts nuevos, y Postiz dejaría de publicar sin que nadie se entere. | `run()` y `reconcile()` (archivo 7) y la actividad (archivo 21) salen sin hacer nada si `!enabled()`. Agregar una prueba en el archivo 54. | IR-B2, CB-M17 |
| B3 | `beforeChangeDate` no aplica la regla central. Un post en `ERROR` de un lote no aprobado vuelve a `QUEUE` y se publica al arrastrarlo en el calendario. | Si la acción final es `schedule` y el post no está en `DRAFT`, exigir que el lote esté `APPROVED`, que la huella coincida y que la fecha sea futura. Si no, responder `400`. Agregar la prueba. | CB-B2, IR-M14 |
| B4 | No existe el script `pnpm lint`, así que la CI y el plan de verificación fallan siempre. | Agregar `"lint": "eslint ."` en el archivo 49, o escribir el comando exacto. | CB-B1, IR-M22 |
| B5 | El archivo 41c describe un cambio que no existe: la línea 197 es un POST, no una clave de SWR. | Quitar el 41c, o reescribirlo para que siempre use la rama con sesión. Arreglar la lectura de comentarios en `preview.comments.context.tsx:45-48`. | CB-B3, IR-M19 |

## 🟡 Major (agrupados)

**Estructura del plan**

*   **No hay fases ni puntos de control** (IR-M1, CB-M1). Proponer 6 fases y
    que cada una termine con `pnpm build` y `pnpm test:fork`.
*   **El esquema Prisma no está escrito** (IR-M2, CB-M22). Faltan
    nulabilidad, valores por defecto, tipos de id, `onDelete`, relaciones con
    `@relation("…")` y los campos inversos en `User`, `Organization` y
    `Comments`.
*   **Los consumidores de `approvalStage` y las claves de traducción quedan
    sin decidir** (IR-M24).

**Contradicciones internas** (algunas vienen de la etapa 8)

*   **Autoría al forzar.** El archivo 5 todavía usa `RESET_BY_EDIT` (IR-M6,
    CB-M10, Style-M1).
*   **Huella de referencia.** Hay tres versiones distintas (CB-M9, IR-M7).
    Además, `CREATED` no guarda huellas.
*   **Reinicio de `PostApproval`.** Se escribe en dos lugares y no se dice qué
    pasa si la `version` no coincide (IR-M3). Propuesta: `applyReset` antes del
    bucle, con `409`.
*   **Margen de la aprobación final.** Dos minutos o "en el futuro" (IR-M13,
    CB-M11). Además, no se dice qué pasa si falla a la mitad.
*   **`force` con fecha pasada.** Choca con `beforeChangeDate`, que rechaza
    fechas pasadas (IR-M14, CB-M12).
*   **Ciclo del workflow de mantenimiento.** Contradice al Technical Plan
    (IR-M11, CB-M18).
*   **Regla de avisos de 15 minutos.** Está duplicada y le falta precisión
    (IR-M9, Style-M4).
*   **Borrado directo de un canal.** No deja `CHANNEL_DISCARDED` y salta la
    regla de rol (CB-M14). Coincide con el hallazgo 6 de la etapa 8.

**Huecos de especificación en el backend**

*   **Fingerprint público.** Hace falta un método público de huella para
    `ApprovalService` y para la tarea de mantenimiento (CB-M2).
*   **`isAllowedMediaPath` es privado** en `PostsService` (CB-M3).
*   **`Media` por lote.** `MediaRepository` no tiene consulta por lote; agregar
    `findExistingMediaIds` en `ApprovalsRepository` (IR-M15, CB-M4).
*   **Prefijos de ruta.** Solo se antepone `UPLOAD_DIRECTORY` a `path`;
    `FRONTEND_URL` va en `url` (CB-M5).
*   **Avisos y dependencias.** Los avisos están en métodos privados y faltan
    dependencias. Propuesta: un `ApprovalNotifyService` compartido (IR-M9,
    IR-M10, CB-M6).
*   **Transacción en el servicio.** Va contra la regla de capas. Propuesta:
    `ApprovalsRepository.transition` con `PrismaTransaction` (IR-M5, CB-M7).
*   **`version`.** Falta en firmas y DTOs (IR-M12, CB-M8). Faltan también el
    rechazo de `submit` sin brief y la regla de fallo de `validatePosts`.
*   **`earliestPublishDate`.** Se recalcula antes de escribir (CB-M13).
*   **Post en `ERROR` dentro de un lote no aprobado.** Puede pasar si gana la
    carrera con el workflow (CB-M15).
*   **`WorkflowType` exacto** en la consulta a Temporal (CB-M16, IR-M10).
*   **`batchId` con el fork apagado.** Queda `null` y rompe el comportamiento
    de upstream (IR-M4).
*   **`actorRole`.** No hay regla para calcularlo cuando una persona tiene
    varios roles (IR-M8).
*   **Preview.** El mapeo del preview expondría tokens de `Integration`, y
    `getComments` no devuelve `{ comments }` (CB-M19).
*   **Suplantación.** La condición no coincide con el middleware y la prueba
    está en el archivo equivocado (CB-M20, CB-M21, IR-M23).
*   **`commentId`.** No se guarda, y `createPublicComment` exige una `ip`
    (CB-M23).
*   **Respuestas y validaciones.** Faltan las formas de respuesta y la
    validación de pertenencia a la organización en `setRoles` (IR-M18).
*   **Huella de media y avisos.** Faltan textos y asuntos de cada aviso, y el
    aviso interno debe ir en texto plano (IR-M16).

**Frontend e infraestructura**

*   **Editor.** No se dice qué `type` envía cada botón, ni qué pasa con "Save
    as Draft" y el modal de varios canales. El panel no conoce el `batchId`
    (IR-M17, CB-M25).
*   **Página `p/[id]`.** Es un Server Component: debe usar
    `process.env.APPROVALS_ENABLED` y `redirect` (IR-M19, CB-M26).
*   **Filtro "Etapa".** Exige modificar `calendar.context.tsx`, que no está
    listado (IR-M20).
*   **"Crear post desde este brief".** No se dice cómo abre el editor desde
    `/briefs` (IR-M21).
*   **CI.** Falta configurar el remoto `upstream`, usar `git show` para el
    esquema y preparar Node, pnpm e install (IR-M22, CB-M24).
*   **Pruebas.**
    *   Faltan las specs de `ApprovalPolicyService`, `BriefsService` y el
        controlador.
    *   Faltan mocks compartidos y `coverageThreshold`.
    *   Hay pruebas duplicadas o vagas (IR-M23, CB-M27, Style-M6, Style-M7,
        Style-M8).
*   **Puertos.** Falta elegir una sola opción (Style-M9 y Nits).

## 🟢 Nits

Hay 29 Nits en total. Los más útiles:

*   reutilizar `Sentry.metrics.count`;
*   reutilizar `OrganizationRepository.getTeam`;
*   hacer que el `grep` de `'QUEUE'` encuentre las escrituras con operador
    ternario;
*   simplificar la condición del modal del calendario;
*   decidir el orden de los parámetros y quién puede cancelar un brief.

## Relación con la etapa 8

B1, B3 y varios Major (huella de referencia, `force` y la marca `version` en
cada capa) tocan los dos compromisos que señaló la etapa 8: decidir antes de
escribir (R1) y no tocar el orquestador (decisión A). Cada uno agrega una regla
más al punto de control.

---

# Resolución: se reabren las decisiones A y R1

La persona dueña del diseño eligió **reabrir A y R1** antes de corregir el
plan.

*   **A (nueva):** la regla central se comprueba en el cuerpo de la actividad
    `getPostsList`, con el mismo patrón que ya usa para la suscripción de
    Stripe.
*   **R1 (nueva):** todo se guarda como `draft`, la huella se calcula solo desde
    las filas y, después, un lote aprobado sin cambios vuelve a `QUEUE`.

| Hallazgo | Cómo queda |
|---|---|
| B1 (un solo `type`) | **Resuelto.** `typeForSave` devuelve `typeByIntegration`; los canales en `PUBLISHED` se guardan con `update`. |
| B2 (la tarea ignora el interruptor) | **Resuelto.** `run()`, `reconcile()` y la actividad salen sin hacer nada si `!enabled()`. Hay prueba y un paso en la verificación de punta a punta. |
| B3 (`beforeChangeDate` no aplica la regla) | **Resuelto** dos veces: `beforeChangeDate` exige `isPublishAllowed`, y `getPostsList` lo bloquea de todos modos. |
| B4 (`pnpm lint`) | **Resuelto.** Script `lint` en el archivo 49 y CI completa en el archivo 47. |
| B5 (archivo 41c) | **Resuelto.** El 41c describe el POST real; la lectura de comentarios está en el 41b. |
| Fases, esquema Prisma y relaciones con nombre | **Resuelto.** Hay una sección "Fases" y el bloque Prisma está completo, con los campos inversos. |
| Autoría y huella de referencia contradictorias | **Resuelto.** Hay una sola definición de cada una (glosario y "Huella del contenido"). |
| `applyReset` y `version` | **Resuelto.** `ApprovalsRepository.transition` usa `PrismaTransaction`, y `version` está en todas las acciones y sus DTOs. |
| Concurrencia (2 minutos, segunda terminación, `503`) | **Eliminado.** Lo cubre `getPostsList`. |
| `normalizeFromBody`, `stripLinks`, `shortLink`, `findBatchIdFor`, lotes mezclados | **Eliminado** por R1. |
| `isAllowedMediaPath` privado | **Resuelto.** Se mueve a un helper (archivo 2b). |
| `Media` por lote | **Resuelto.** `findExistingMediaIds` en el repositorio del fork. |
| Avisos sin dueño | **Resuelto.** `ApprovalNotifyService` (archivo 2c), con tabla de plantillas y texto plano en el aviso interno. |
| `force` con fecha pasada | **Resuelto.** `changeDate(now + 1 min, 'update')` y después `schedule`; se quitó `allowPastDate`. |
| "Descartar canal" duplicado | **Resuelto.** Lo registra `beforeDeletePost`; se quitaron el endpoint, el DTO y la regla de rol. |
| Preview, tokens, `{ comments }`, Server Component | **Resuelto** (archivos 5, 41 y 41b). |
| Suplantación | **Resuelto.** Usa la condición exacta del middleware, y la prueba está en el spec del controlador (53c). |
| Botones del editor, `batchId` en el panel, filtro "Etapa", brief → editor | **Resuelto** (archivos 34, 37b y 32b). |
| CI (remoto `upstream`, `git show`, Node y pnpm) | **Resuelto** (archivo 47). |
| Specs que faltaban, mocks y cobertura | **Resuelto** (52b, 53b, 53c, 55b y archivo 48). |
| Consumidores de `approvalStage` y claves de traducción | **Resuelto** (archivos 9 y 42). |

**Estado:** aplicado. Queda pendiente la revisión adicional de la etapa 9, que
es la única que se permite.

---

# Etapa 9: revisión adicional (la única permitida)

| Revisor | Hallazgos |
|---|---|
| `egm-implementation-readiness` | 2 Blocker, 13 Major y 12 Nit |
| `egm-codebase-details` | 1 Blocker, 13 Major y 10 Nit |
| `egm-style` | 6 Major y 11 Nit |

Los dos revisores de código coinciden en el Blocker B1 y en casi todos los
Major. El revisor de preparación concluyó: "Con B1, B2 y M1 a M8 resueltos, el
plan quedaría listo para implementarse".

## Aplicado

*   **B1, reinicio sin terminar workflows.** `afterSave`, `afterDeletePost` y
    `beforeChangeDate` devuelven `toDraft`. `PostsService` pasa esos posts a
    `DRAFT` y llama a `startWorkflow(DRAFT)` con `await`. El punto de control
    nunca escribe `Post.state`. Se agregó una prueba.
*   **B2, fases que no compilan.** El archivo 8 se aplica por partes en las
    fases 2, 3 y 4. El helper 55b pasa a la fase 2 y crece en cada fase. Se
    agregó `passWithNoTests`, y los umbrales de cobertura se activan en la
    fase en que se crea cada archivo.
*   **Major de los revisores de código:**
    *   `evaluatePublish` es una función sin efectos, separada de
        `isPublishAllowed`.
    *   Las marcas de aviso solo se borran si la fecha cambia.
    *   La tarea de mantenimiento recorre también las organizaciones sin
        `PostApproval`.
    *   El paso 5a tiene un algoritmo numerado, y se definió la reversión de la
        aprobación final.
    *   Se separaron `beforeDeletePost` y `afterDeletePost`, se agregó
        `getRootPostByGroup`, y `changeDate` y `deletePost` pasan la superficie.
    *   `approvalStage` sale de `stageByPostId`.
    *   El nombre visible del actor se arma con `name` y `lastName`.
    *   Se agregó un componente cliente `open.from.brief.tsx` y
        `GET /briefs/:id`.
    *   Se corrigieron la tabla de botones del editor y las líneas que se
        omiten.
    *   El calendario maneja el `400`, y desapareció el "Reschedule" para posts
        publicados.
    *   El filtro "Etapa" quedó conectado en la interfaz, el wrapper y la vista
        de lista.
    *   Se agregaron la tabla de estados del brief, el mapeo de roles por
        acción y la excepción de validación (`BadRequestException`).
    *   La carrera del `startWorkflow` sin `await` quedó resuelta.
    *   `guardAgainstRepublish` usa el tipo por canal, y `now` conserva la
        fecha de upstream.
    *   CI con Postgres y `pnpm build`.
    *   Lint limitado a los archivos del fork.
    *   Pruebas sobre Postgres real con `jest-mock-extended` para Temporal, y
        los specs 52c y 55c.
*   **Estilo:** M1, M2, M3, M4, M5 y M6, y los Nits N10 y N11.

## Decisiones mecánicas que tomó el Elephant

| Decisión | Por qué |
|---|---|
| Un canal con fecha pasada y `schedule` se guarda como `draft` (con `BLOCKED` y `past_date`), en vez de rechazar toda la petición con `400`. | Así un lote aprobado con un canal en `ERROR` no bloquea a los demás. `changePostStatus` mantiene el `400`. |
| Un brief se puede enlazar a varios lotes. | El tema existe antes que el post y puede generar varios. |
| Las pruebas usan un Postgres real y Temporal se simula con `jest-mock-extended`. | Simular Prisma completo sería otro ORM. `jest-mock-extended` ya está en el repo. |
| El script es `lint:fork` y no cubre el repo completo. | El lint del repo completo no se ejecuta en upstream y puede fallar por código ajeno. |

## Rechazados (DECLINE)

Los Nits de estilo N1 a N9 (términos en inglés, sinónimos) y los Nits de código
N3 (cookie `impersonate` vieja en un superadmin: se acepta el `403`) y N9
(revisar la documentación de Next 16 antes de usar `redirect`, que queda como
nota para quien implemente).

## Cierre de la etapa 9

**Se alcanzó el límite:** solo se permite una revisión adicional y ya se usó.
Los arreglos de esta revisión se aplicaron, pero ningún revisor los volvió a
leer. Antes de implementar, se recomienda una revisión de la fase 2 al
terminarla.
