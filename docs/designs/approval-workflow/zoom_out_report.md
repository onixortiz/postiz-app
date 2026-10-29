# Etapa 5: revisión de alcance inicial (Zoom Out)

*   **Documento:** `docs/designs/approval-workflow.md` (líneas 1 a 1623, completo)
*   **Revisor:** `egm-zoom-out`, sin acceso a la conversación
*   **Estándar:** `zoom-out-standard.md`
*   **Fecha:** 2026-10-28

## Veredicto

**El diseño necesita cambios.** El documento explica qué se quiere lograr y por
qué, así que pasa el chequeo previo de contexto. La idea central se mantiene:
nada que no esté aprobado sale de `DRAFT`, y eso se aplica en la capa de
servicio.

El revisor comprobó en el código cuatro afirmaciones del documento:

*   `startWorkflow` no inicia nada para `DRAFT` (`posts.service.ts:965`).
*   La tarea de cada hora solo lee `QUEUE` (`posts.repository.ts:36-64`).
*   Sin Stripe, `PermissionsService.check` concede todo
    (`permissions.service.ts:50-63`).
*   `createPost`, `changeDate` y `changePostStatus` son los únicos que escriben
    `QUEUE`. No encontró ningún otro camino.

**Comprobación propia del Elephant.** Confirmé en el código las afirmaciones de
los hallazgos 2 y 5:

*   `short.link.service.ts:81-86` deja sin cambios los links que ya pertenecen
    al dominio corto.
*   `inAppNotification(orgId, subject, message, sendEmail, digest, type)` no
    tiene parámetro `link` (`notification.service.ts:41-48`).
*   `hasEmailProvider()` existe (`notification.service.ts:114`).

## Hallazgos

### 1. 🔴 Blocker: el punto de control decide canal por canal, pero la unidad de aprobación es el lote

*   **Dónde:** Technical Plan, "Cómo cada camino pasa por el punto de control";
    archivo 4 (`beforeCreatePost`, pasos 5 y 6); archivo 9.
*   **Problema:** `createPost` recorre `body.posts` canal por canal
    (`posts.service.ts:1156-1224`) e inicia cada workflow sin esperar a que
    termine de arrancar (`this.startWorkflow(...).catch(...)`, línea 1211).
    Este es el escenario: en un lote aprobado de dos canales, solo cambia el
    canal B.
    1.  El canal A se procesa primero. Su huella no cambió, así que pasa como
        `schedule`, queda en `QUEUE` y se lanza su workflow.
    2.  El canal B tiene otra huella. El punto de control cancela los workflows
        de todo el lote y `afterCreatePost` pasa A a `DRAFT`.

    El workflow de A, lanzado sin esperar, puede arrancar después de la
    cancelación. Si lee `QUEUE` antes de que A pase a `DRAFT`, se duerme y
    publica al despertar. Solo lo detecta la conciliación, en hasta 15
    minutos.

    Es decir, el propio diseño abre el hueco de la decisión A en el camino
    principal, el editor, no en un camino desconocido.
*   **Cambio sugerido:** evaluar el lote una sola vez, **antes** del bucle, con
    `decideBatch(orgId, body)`:
    *   Calcula todas las huellas del lote y devuelve un solo `type` y un solo
        `inter` para todo el cuerpo.
    *   Si hay que reiniciar, cancela los workflows antes de escribir nada.
    *   Dentro del bucle solo se usa `decision.type`.
    *   La prueba 55 agrega el caso "lote de 2 canales, cambia solo el
        segundo".

### 2. 🟡 Major: la salida propuesta para `shortLink` choca con `normalizeFromRows`, y la pregunta ya tiene respuesta en el código

*   **Dónde:** Open Questions; "Huella del contenido"; archivo 52.
*   **Problema:**
    *   **La salida no funciona.** El plan B es calcular la huella "sobre el
        texto antes de acortar los links". Pero `normalizeFromRows` solo ve el
        texto guardado, que ya está acortado. Con ese plan B, las dos
        funciones de normalización nunca coincidirían.
    *   **El riesgo no existe.** En `short.link.service.ts:81-86`, un link que
        ya pertenece al dominio corto queda igual. Sin proveedor de links
        cortos, el texto no cambia.
*   **Cambio sugerido:** cerrar la pregunta abierta citando ese código y quitar
    el plan B. Opcional: con el fork activo, forzar `shortLink = false` en el
    punto de control.

### 3. 🟡 Major: el alcance de la v1 está inflado (YAGNI)

*   **Dónde:** metas 3, 7, 10 y 11; tablas `ContentBrief` y `PostApproval`;
    archivos 6, 11, 14, 29, 32, 33, 35 y 37.
*   **Problema:** son 55 archivos, unos 25 de ellos de upstream. Varias piezas
    no protegen nada:
    *   **Briefs y `quickBrief`.** El brief no controla nada: cualquiera crea
        el lote en `IN_PRODUCTION`, y si no hay brief, el Creator inventa uno.
        Arrastra una tabla, un servicio, un controlador, dos DTOs, dos
        pantallas, un modal, un campo en el store del editor y `link-brief`.
    *   **Verificación después de publicar.** Suma tres etapas, `verifyDueAt`,
        dos pasos de la tarea de mantenimiento y el brief de corrección.
    *   **Filtro "Etapa" del calendario** y **avisos de 48 h y 24 h**.
*   **Cambio sugerido:** dividir el trabajo en dos versiones.
    *   **v1:** roles, punto de control, revisión, aprobación final, rechazo,
        forzar, historial, bandeja y correo al siguiente rol. El tema va en un
        campo opcional `topic` de `PostApproval`.
    *   **v2:** briefs, verificación, avisos previos y filtros.

### 4. 🟡 Major: guardar `EXPIRED` como etapa y restaurarla agrega complejidad sin beneficio

*   **Dónde:** filas de `EXPIRED` en la tabla de transiciones;
    `stageBeforeExpiry`; `reviewerApprovedFingerprints`; `beforeChangeDate`;
    paso 1 de la tarea de mantenimiento.
*   **Problema:**
    *   **Vencido no protege nada.** Un lote no aprobado ya está en `DRAFT`, así
        que nunca se publica. "Vencido" solo sirve para mostrarlo.
    *   **Cuesta mucho mantenerlo.** Guardarlo como etapa obliga a tener
        `stageBeforeExpiry`, una transición de vuelta, el evento `RESCHEDULED`,
        una regla de prioridad y una rama más en `beforeChangeDate`.
    *   **Hay dos mecanismos para lo mismo.** `reviewerApprovedFingerprints`
        guarda en una columna lo que el evento `SUBMITTED` ya guarda en el
        historial.
*   **Cambio sugerido:**
    *   "Vencido" pasa a ser un valor calculado: etapa anterior a `APPROVED` y
        `earliestPublishDate < ahora`. Un campo `warnedExpiredAt` evita que el
        aviso se repita.
    *   Las huellas de referencia se leen siempre de
        `PostApprovalEvent.fingerprints`.
    *   El CUJ 4 queda igual.

### 5. 🟡 Major: se reinventan los avisos en lugar de usar lo que ya existe

*   **Dónde:** sección Avisos; archivo 5 (`notifyRole`).
*   **Problema:**
    *   `NotificationService` ya junta el aviso interno y el correo, respeta las
        preferencias de cada usuario y sabe si hay proveedor de correo
        (`hasEmailProvider()`).
    *   El documento dice que `inAppNotification` acepta un `link`, pero su
        firma no lo tiene.
*   **Cambio sugerido:**
    *   El link va dentro de `message`.
    *   Avisos internos con `inAppNotification(orgId, subject, html, false)`.
    *   Correos con `sendEmail`, solo para las personas del rol.
    *   Avisos a todo el equipo con `inAppNotification(..., true)`.
    *   La advertencia al arrancar usa `hasEmailProvider()`.

### 6. 🟢 Nit: demasiado detalle de código en el plan

*   **Dónde:** archivos 2, 4 y 10.
*   **Problema:** las firmas de unos 20 métodos, el algoritmo de 7 pasos y las
    longitudes de los DTOs se van a desactualizar con el primer cambio, por
    ejemplo el del hallazgo 1.
*   **Cambio sugerido:** describir la responsabilidad y la interfaz de cada
    componente (entradas, salidas y errores). Las firmas y los valores van en
    el PR.

### 7. 🟢 Nit: se rehace la página de preview cuando bastaría con cerrarla

*   **Dónde:** "Página de preview"; archivos 17 y 41.
*   **Problema:** la meta 12 se cumple con que los endpoints públicos respondan
    `404`. Un endpoint nuevo con sesión para el preview es trabajo extra, porque
    el panel del editor ya muestra el contenido y el historial.
*   **Cambio sugerido:** en la v1, solo el `404` y la comprobación de
    organización en `POST /posts/:id/comments`. El preview con sesión queda
    para la v2.

### 8. 🟢 Nit: `terminatePostWorkflows` repite la consulta de `startWorkflow`

*   **Dónde:** "Cancelación estricta de workflows"; archivo 4.
*   **Problema:** si upstream cambia el atributo de búsqueda `postId`, la copia
    no se entera.
*   **Cambio sugerido:** registrar la copia en `FORK_TOUCHPOINTS.md`, con
    referencia a `posts.service.ts:944-963`, y agregar al procedimiento de
    actualización el paso "comparar con `startWorkflow`".

## Qué conviene mantener

*   El punto de control en la capa de servicio, en lugar de un middleware de
    Prisma o un workflow V113.
*   Tablas nuevas en lugar de tocar los enums `Role` y `State`.
*   El uso de `batchId` como llave del lote.
*   La reutilización del patrón de `missingPostWorkflow` y de
    `InfiniteWorkflowRegister`.
*   La conciliación, con su métrica, como red de seguridad visible.

## Archivos que leyó el revisor

*   `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`
*   `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
*   `libraries/nestjs-libraries/src/database/prisma/notifications/notification.service.ts`
*   `libraries/nestjs-libraries/src/short-linking/short.link.service.ts`
*   `apps/orchestrator/src/workflows/missing.post.workflow.ts`
*   `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts`
*   `apps/backend/src/services/auth/permissions/permissions.service.ts`
*   `apps/backend/src/api/routes/posts.controller.ts`

## Resolución (primera pasada)

| Hallazgo | Resultado |
|---|---|
| 1. Decisión canal por canal | **Aplicado.** `decideBatch` decide una vez por lote, antes del bucle, y cancela los workflows antes de escribir. Se agregaron dos pruebas en los archivos 52 y 55. |
| 2. `shortLink` | **Aplicado.** Con el fork activo, `shortLink` se fuerza a `false`. Se quitó el plan B y se cerró la pregunta abierta. |
| 3. Alcance de la v1 | **Compromiso aceptado.** La persona dueña del diseño mantiene la v1 completa, con briefs, tema rápido, verificación, avisos previos y filtro. |
| 4. `EXPIRED` como etapa | **Aplicado.** "Vencido" es un valor calculado. Se quitaron `stageBeforeExpiry`, `reviewerApprovedFingerprints` y `RESCHEDULED`, y se agregó `warnedExpiredAt`. |
| 5. Avisos | **Aplicado.** Se usan `inAppNotification` y `hasEmailProvider()` tal como existen. Se corrigió la mención a `link`. |
| 6. Detalle de código | **Aplicado en parte.** `decideBatch` se describe por entradas, salidas y errores. El resto conserva sus firmas. |
| 7. Preview | **Compromiso aceptado.** Se mantiene el preview con sesión, porque los comentarios anclados al texto solo existen en esa página. |
| 8. Copia de la consulta | **Aplicado.** Se agregaron una fila en `FORK_TOUCHPOINTS.md` y dos pasos al procedimiento de actualización. |

---

# Segunda pasada de la etapa 5 (última revisión permitida)

*   **Revisor:** un `egm-zoom-out` nuevo, sin acceso a la conversación.
*   **Veredicto:** la idea central es buena y no hay Blockers. Hay 5 Major y
    5 Nit.
*   **Verificación del Elephant:** comprobé en el código el hallazgo 3:
    `postWorkflowV112` llama a `postSocialPending`
    (`post.workflow.v1.1.2.ts:442`), no a `postSocial`, y las dos actividades
    delegan en `postSocialInternal` (`post.activity.ts:261-272`).

## Hallazgos nuevos

### R1. 🟡 Major: decidir antes de escribir obliga a mantener tres copias de lógica de upstream

*   **Dónde:** "Huella del contenido", "Una decisión por lote" y los archivos 2
    y 4.
*   **Problema:** para calcular la huella desde el cuerpo de la petición hacen
    falta:
    *   dos adaptadores, `normalizeFromBody` y `normalizeFromRows`;
    *   una copia de `stripLinks`, con la dependencia de `IntegrationManager`;
    *   forzar `shortLink = false`, con lo que el equipo pierde esa función;
    *   `findBatchIdFor`, que copia el criterio de `posts.repository.ts:626-649`
        y no figura en `FORK_TOUCHPOINTS`.
*   **Cambio sugerido:** decidir después de escribir.
    1.  Antes del bucle, cancelar de forma estricta los workflows del lote.
    2.  Guardar siempre como `draft`, salvo `update`.
    3.  Después del bucle, calcular la huella desde las filas guardadas.
    4.  Si el lote está `APPROVED` y la huella coincide, pasar los posts a
        `QUEUE` y lanzar `startWorkflow`. Si no, reiniciar.

    Esto elimina un adaptador, la copia de `stripLinks`, el forzado de
    `shortLink` y `findBatchIdFor`.

### R2. 🟡 Major: la meta 1 promete más de lo que garantiza la decisión A

*   **Dónde:** meta 1 frente a "El hueco que queda".
*   **Problema:** la meta dice "ningún camino", pero la decisión A acepta que un
    camino desconocido pueda publicar antes de que lo detecte la conciliación.
*   **Cambio sugerido:** que la meta diga "ningún camino conocido de los
    enumerados" y cite la decisión A y la métrica `approval_reconciled`.

### R3. 🟡 Major: la alternativa I tiene la cuenta de costos incompleta y nombra mal la actividad

*   **Dónde:** alternativa I y Future Improvements.
*   **Problema:**
    *   **Costos.** No dice qué piezas del fork se podrían quitar si se
        adopta: la cancelación estricta con `503`, la copia de la consulta de
        `startWorkflow` y el punto 5b de la conciliación.
    *   **Nombre.** Habla de `postSocial`, pero V112 usa `postSocialPending`.
        El lugar común de las dos es `postSocialInternal`.
*   **Cambio sugerido:** corregir el destino a `postSocialInternal` y
    `postComment`, y completar el trade-off con lo que se eliminaría.

### R9. 🟢 Nit: se habla de "cuatro métodos", pero los puntos de escritura son tres

*   **Dónde:** "La regla central" y el diagrama.
*   **Problema:** `updatePostSettings` delega en `createPost('update')`, así que
    no es un punto de escritura propio.
*   **Cambio sugerido:** hablar de tres puntos de escritura y mostrar
    `updatePostSettings` como uno de los que llaman a `createPost`.

### R8. 🟢 Nit: el Technical Plan baja al detalle de código

*   **Dónde:** "Cancelación estricta", "Avisos" y "Roles y permisos".
*   **Problema:** muestra la consulta textual de Temporal, parámetros booleanos
    y firmas de métodos.
*   **Cambio sugerido:** dejar solo el contrato en el Technical Plan.

### R7. 🟢 Nit: hay cambios de infraestructura fuera del alcance

*   **Dónde:** la corrección de `docker-build.sh` y el cambio a volúmenes con
    nombre.
*   **Cambio sugerido:** marcarlos como requisitos previos, o hacerlos en un
    cambio aparte.

## Hallazgos que repiten compromisos ya aceptados

*   **R4:** briefs.
*   **R5:** verificación con etapas.
*   **R6:** avisos de 48 h y 24 h.
*   **R10:** filtro "Etapa".

Todos son parte del hallazgo 3 de la primera pasada, que la persona dueña del
diseño aceptó mantener en la v1. Se registran sin cambios.

## Cierre de la etapa 5

La persona dueña del diseño eligió pasar a la etapa 6 sin aplicar los hallazgos
de la segunda pasada. Todos quedan como **compromisos aceptados**: R1, R2, R3,
R7, R8 y R9, además de R4, R5, R6 y R10, que ya estaban aceptados.
