Status: resolved (ronda 1: 37 PROPOSE FIX aplicados, 1 CONTEST, 4 DECLINE)

# Goldfish Annotated Review Report

**Target:** `docs/designs/approval-workflow.md` (líneas 1-901, FeatureRange; los
arreglos que tocan el plan de implementación se indican)
**Etapa:** 7, ronda 1. Lista de origen: `critic_report.md`.

**Resumen de la clasificación**

| Clasificación | Hallazgos | Cuántos |
|---|---|---|
| PROPOSE FIX | 1 a 28, 30 a 34, 37, 39 y 40 | 37 |
| CONTEST | 35 | 1 |
| DECLINE | 29, 36, 38 y 41 | 4 |
| ESCALATE | ninguno | 0 |

Los hallazgos 5 y 6 cambian reglas del flujo. Quedan como PROPOSE FIX, pero
conviene que los apruebes a conciencia.

## Prioritized Findings & AI Suggestions

### [Issue 1] [`egm-style`] - Severity: High
*   **Affected Scope:** [Lines 24-26, 69-73, 246-247](docs/designs/approval-workflow.md#L24-L247) (Overview, Goals, La regla central)
*   **Discrepancy Description:** El documento promete que "ningún post llega a una red sin aprobación, salga por donde salga". La sección "El hueco que queda" acepta que un post puede publicarse si un workflow dormido se adelanta a la conciliación.
*   **Rationale:** Quien lee solo las metas se lleva una garantía que el diseño no da.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Es un error de redacción, no de diseño. Ya se había marcado en la etapa 5 como R2, y ahí se pasó de etapa sin aplicarlo. Ahora llega como Blocker y el arreglo solo cambia palabras.
*   ***Proposed Edit:***
    *   **Overview:** "Ningún post entra en `QUEUE` sin la aprobación final del Monthly Reviewer, por ninguno de los caminos de publicación conocidos (ver la tabla de caminos)."
    *   **Meta 1:** "Ningún camino conocido pone en `QUEUE` un post sin aprobación final. Riesgo aceptado: ver 'Riesgo aceptado: workflow dormido' en Riesgos y mitigaciones."
    *   **Línea 246:** "basta para que no se publique por los caminos conocidos".

### [Issue 2] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 280-284, 384, 455 (diagrama, aprobación final)
*   **Discrepancy Description:** Una edición que llega en el mismo momento que la aprobación final puede quedar en `QUEUE` con texto que nadie aprobó. `changePostStatus` no es transaccional, y V112 lee el contenido al despertar.
*   **Rationale:** Rompe la meta 1 en el camino principal.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** La carrera es real. El documento no tiene ningún control de concurrencia entre el punto de control y `ApprovalService`.
*   ***Proposed Edit:***
    *   `PostApproval` agrega el campo `version` (entero). Todas las transiciones y los reinicios usan `updateMany where { id, version }` y suman 1. Esto es concurrencia optimista hecha con Prisma, sin SQL crudo.
    *   Las peticiones de aprobación, simples o en lote, envían la `version` que vio quien aprueba. Si no coincide, se rechazan con `409`.
    *   Después de pasar los posts a `QUEUE`, la aprobación final recalcula la huella desde la base. Si no coincide, vuelve a `DRAFT` y cancela los workflows.
    *   La frase "misma transacción" queda limitada a las escrituras de las tablas del fork.

### [Issue 3] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 457-469 (Cancelación estricta)
*   **Discrepancy Description:** `workflow.list()` lee la visibilidad de Elasticsearch, que va con retraso, así que no ve un workflow creado hace milisegundos.
*   **Rationale:** La cancelación "tiene éxito" y el workflow sigue vivo.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Postiz siempre usa el ID fijo `post_${postId}` con `TERMINATE_EXISTING` ([posts.service.ts:973-975](libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L973)).
*   ***Proposed Edit:*** "`terminatePostWorkflows` cancela primero por el ID fijo `post_${postId}` con `getWorkflowHandle(...).terminate()`, y trata 'no encontrado' como éxito. Después cancela lo que devuelva `list()` como complemento." También se agrega el riesgo a la tabla nueva.

### [Issue 4] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 384-397, 455 (aprobación final, canal con error)
*   **Discrepancy Description:** Reaprobar o forzar un lote pasa a `QUEUE` todos los posts raíz, incluidos los que ya están en `PUBLISHED`. Eso los vuelve a publicar.
*   **Rationale:** El post se duplica en la red.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `changePostStatus` no llama a `guardAgainstRepublish` ([posts.service.ts:1384-1407](libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L1384)).
*   ***Proposed Edit:***
    *   La aprobación final y la publicación forzada solo pasan a `QUEUE` los posts raíz que **no** están en `PUBLISHED`.
    *   Un canal ya publicado queda fuera de la huella del reinicio y no se puede volver a publicar desde el flujo. Editar un post publicado sigue la regla de Postiz: `type: update` y nunca se republica.
    *   `republish: true` queda bloqueado mientras el fork esté activo.

### [Issue 5] [`egm-design`, `egm-structural`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 92-94, 385, 212-217 (meta 8, transición "Forzar", CUJ 6)
*   **Discrepancy Description:** No se dice si forzar guarda huellas; si no las guarda, la conciliación deshace la publicación forzada. Tampoco se dice si ejecuta `validatePosts`, qué fecha usa, ni si alguien puede forzar un lote propio.
*   **Rationale:** Tal como está escrito, la publicación forzada no funciona, y una sola persona con dos roles podría publicar sin ningún control.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El código de la regla central lo confirma: sin `approvedFingerprints`, la conciliación pasa el post a `DRAFT`.
*   ***Proposed Edit:*** Forzar hace cinco cosas:
    1.  Ejecuta `validatePosts`.
    2.  Guarda las huellas actuales en `approvedFingerprints`.
    3.  Publica en la fecha programada si es futura, o de inmediato (como `now`) si ya pasó.
    4.  **No se permite** si quien fuerza envió o editó la versión actual.
    5.  Toda publicación forzada avisa por correo a los ADMIN.

    **El punto 4 restringe tu decisión 16** (solo el Monthly Reviewer puede forzar). Si no lo quieres, se declara como riesgo aceptado.

### [Issue 6] [`egm-design`, `egm-structural`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 81-82, 381-386; plan: `decideBatch` y `reviewApprove`
*   **Discrepancy Description:** Una edición en `IN_REVIEW` no crea un evento de referencia nuevo, así que el lote queda atascado: `reviewApprove` nunca coincide. Además, quien editó puede aprobar su propio texto.
*   **Rationale:** Es lógica que no cierra (C1) y deja un hueco en la meta 4.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Este hueco nació al quitar `reviewerApprovedFingerprints` en la etapa 5.
*   ***Proposed Edit:***
    *   Todo cambio de huella en `IN_REVIEW`, `AWAITING_FINAL` o `APPROVED` deja el lote en `IN_REVIEW` y registra `RESET_BY_EDIT` con `actorUserId` y las huellas nuevas.
    *   Ese evento pasa a ser la referencia nueva, igual que un `SUBMITTED`.
    *   La regla de la meta 4 queda así: "no puede aprobar quien envió el lote ni quien sea autor de un `RESET_BY_EDIT` desde el último `SUBMITTED`".
    *   Avisar a los Reviewer después de cada guardado sería ruido, así que se avisa como máximo una vez cada 15 minutos por lote.

### [Issue 7] [`egm-design`, `egm-structural`] - Severity: Medium
*   **Affected Scope:** Lines 402-406 (Huella)
*   **Discrepancy Description:** `alt` y `thumbnail` se publican, pero la huella no los incluye. En cambio, incluye el `id` de la media, que MCP genera de nuevo en cada envío.
*   **Rationale:** Un cambio posterior a la aprobación pasa sin control, y un contenido idéntico parece distinto.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo confirma [media.dto.ts:15-21](libraries/nestjs-libraries/src/dtos/media/media.dto.ts#L15) y `makeId(10)` en `integration.schedule.post.ts:279`.
*   ***Proposed Edit:*** "Media: `path`, `alt` y `thumbnail` de cada elemento, en orden. No se usa el `id`." Se agrega una prueba que comprueba que cambiar `alt` cambia la huella.

### [Issue 8] [`egm-design`, `egm-structural`] - Severity: Medium
*   **Affected Scope:** Lines 515-519, 608, 630-635 (tarea de mantenimiento, despliegue, instalación inicial)
*   **Discrepancy Description:** El documento dice que la tarea arranca en el orquestador. En el código, `InfiniteWorkflowRegisterModule` se carga en el backend, el workflow tiene un ID fijo y el patrón real es un `while` con `continueAsNew` periódico. Además, al reactivar `APPROVALS_ENABLED`, los posts programados mientras estuvo apagado pueden publicarse antes de la conciliación.
*   **Rationale:** La descripción no coincide con el código, y queda un riesgo al hacer vuelta atrás.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo confirma `apps/backend/src/app.module.ts:34`.
*   ***Proposed Edit:***
    *   Corregir la descripción: lo registra el backend, solo cuando `RUN_CRON` está definida, con ID fijo `approval-sweep-workflow`, en un bucle con `sleep` de 15 minutos y `continueAsNew` periódico.
    *   Agregar una conciliación síncrona en `onModuleInit` del backend cuando `APPROVALS_ENABLED=true`. Así, al arrancar o al reactivar el fork, ningún post en `QUEUE` sin aprobación queda esperando hasta 15 minutos.

### [Issue 9] [`egm-design`, `egm-structural`] - Severity: Medium
*   **Affected Scope:** Line 314 (índice de `WorkflowRoleAssignment`)
*   **Discrepancy Description:** Prisma 6.5 no expresa un índice único parcial sobre "filas no borradas".
*   **Rationale:** Habría que usar SQL crudo, que choca con `db push` y con `CLAUDE.md`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El repo usa Prisma 6.5.0 (`package.json`), y `CLAUDE.md` prohíbe el SQL crudo.
*   ***Proposed Edit:*** Pasar a borrado físico, sin `deletedAt`, con `@@unique([organizationId, userId, role])`. Cada alta o baja queda en `PostApprovalEvent`, con `approvalId` opcional y las acciones nuevas `ROLE_ASSIGNED` y `ROLE_REMOVED`. Esto también resuelve el hallazgo 32.

### [Issue 10] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 538-547 (Preview)
*   **Discrepancy Description:** Al apagar `GET /public/posts/:id/comments`, el preview deja de poder leer los comentarios.
*   **Rationale:** El preview con sesión, que decidiste mantener, quedaría sin comentarios.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo confirman `preview.comments.context.tsx:45-48` y `comments.components.tsx:197`.
*   ***Proposed Edit:*** Agregar `GET /approvals/preview/:id/comments`, filtrado por organización. Se suman al plan dos archivos de upstream: `preview.comments.context.tsx` y `comments.components.tsx`.

### [Issue 11] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 499-506 (Avisos)
*   **Discrepancy Description:** `inAppNotification(..., true)` usa por defecto el tipo `success`, que se salta a quienes apagaron ese tipo de correo. Además, el aviso interno lo ve toda la organización.
*   **Rationale:** Avisos críticos como `EXPIRED` o `FORCED` podrían no llegarle a nadie.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo confirma `notification.service.ts:96-101`.
*   ***Proposed Edit:*** Los avisos a todo el equipo se envían con el tipo `'info'`, que se manda siempre. Además se aclara que el aviso interno lo ve toda la organización y que el correo dirigido es lo que señala a la persona que le toca.

### [Issue 12] [`egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 471-476, 614-626 (riesgo aceptado, observabilidad)
*   **Discrepancy Description:** La alerta `approval_reconciled` depende de Sentry, y Sentry es opcional.
*   **Rationale:** Sin Sentry, nadie vigila el riesgo aceptado.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Ninguna variable de Sentry figura como obligatoria en el documento.
*   ***Proposed Edit:*** Cada `RECONCILED` envía además un correo directo a los ADMIN de la organización con el post y el `batchId`. Sentry queda como complemento.

### [Issue 13] [`egm-design`, `egm-structural`] - Severity: Medium
*   **Affected Scope:** Documento completo
*   **Discrepancy Description:** Falta la sección "Riesgos y mitigaciones" que exige el estándar.
*   **Rationale:** Los riesgos están repartidos por el documento y algunos no aparecen.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo exige `feature-spec-standard.md`.
*   ***Proposed Edit:*** Una sección `## Riesgos y mitigaciones` antes de Alternativas, con una tabla de columnas Riesgo | Impacto | Mitigación | Señal | Riesgo residual. Filas:
    *   workflow dormido (el riesgo aceptado);
    *   visibilidad de Temporal con retraso;
    *   Temporal caído (los guardados de lotes aprobados responden `503`);
    *   cancelación seguida de una escritura que falla;
    *   carreras entre aprobación y edición;
    *   republicación;
    *   una persona con varios roles;
    *   avisos perdidos;
    *   MCP que divide los lotes;
    *   cambios de upstream que desalinean el fork;
    *   exposición del preview.

### [Issue 14] [`egm-structural`] - Severity: Medium
*   **Affected Scope:** Lines 230, 450 (Glosario, fila de MCP)
*   **Discrepancy Description:** MCP llama a `createPost` una vez por canal, así que cada canal queda en su propio lote.
*   **Rationale:** Contradice "la unidad de aprobación es el lote".
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Lo confirman `integration.schedule.post.ts:249-285` y `posts.service.ts:1155`.
*   ***Proposed Edit:*** Documentarlo como límite conocido de la v1: los posts creados por MCP se aprueban por canal. Se agrega a Riesgos y a la fila MCP de la tabla de caminos. No se toca `integration.schedule.post.ts`.

### [Issue 15] [`egm-structural`] - Severity: Medium
*   **Affected Scope:** Lines 342, 523-530
*   **Discrepancy Description:** El paso 4 de la tarea vuelve a avisar cada 15 minutos.
*   **Rationale:** El documento dice que todos los pasos son idempotentes, y este no lo es.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `verifyDueAt` es un plazo, no una marca de que ya se avisó.
*   ***Proposed Edit:*** Agregar `warnedVerifyAt` y poner `verifyDueAt` en su propia fila. El paso 4 solo actúa si `warnedVerifyAt` está vacío.

### [Issue 16] [`egm-structural`, `egm-style`, `egm-design`] - Severity: Medium
*   **Affected Scope:** Lines 845-846, 885-886
*   **Discrepancy Description:** El runbook no está enlazado. Además, quitar el bloque del esquema hace fallar el arranque, porque `db push` borraría tablas.
*   **Rationale:** La vuelta atrás no se puede seguir.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El archivo 51 ya define `docs/fork/runbook.md`.
*   ***Proposed Edit:*** Enlazar `docs/fork/runbook.md` y resumir los pasos ahí mismo:
    1.  Hacer un respaldo.
    2.  Poner `APPROVALS_ENABLED=false`.
    3.  Quitar el bloque `FORK` y las relaciones inversas.
    4.  Ejecutar `db push --accept-data-loss` una vez, a mano, **antes** de reiniciar, para que el arranque no falle.

### [Issue 17] [`egm-structural`, `egm-style`] - Severity: Medium
*   **Affected Scope:** Line 888
*   **Discrepancy Description:** "Future Improvements" está en nivel H3, dentro de NFR.
*   **Rationale:** Se lee como si fuera un requisito no funcional.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Es un problema estructural.
*   ***Proposed Edit:*** Cambiar a `## Future Improvements`.

### [Issue 18] [`egm-structural`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 127-129 frente a 632-635
*   **Discrepancy Description:** Un lugar dice que hay un script y otro dice que no hace falta.
*   **Rationale:** Es una contradicción interna.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El texto de los Non-Goals quedó de antes de la conciliación con el brief.
*   ***Proposed Edit:*** Non-Goal: "Migrar posts existentes. Es una instalación nueva; la conciliación al arrancar y la de `approvalSweepWorkflow` regresan a `DRAFT` cualquier post en `QUEUE` sin aprobación."

### [Issue 19] [`egm-style`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 144, 471, 1182
*   **Discrepancy Description:** "Decisión A" choca con "Alternativa A".
*   **Rationale:** Es un nombre ambiguo.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Las dos etiquetas existen en el documento con significados distintos.
*   ***Proposed Edit:*** Renombrar a "Riesgo aceptado: workflow dormido" y enlazar la fila de la tabla de riesgos.

### [Issue 20] [`egm-style`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 133, 151, 632
*   **Discrepancy Description:** "Brief" se usa como documento de concepto y como `ContentBrief`.
*   **Rationale:** Un mismo término tiene dos significados.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El glosario define "Brief" como `ContentBrief`.
*   ***Proposed Edit:*** Para el documento previo, usar "el documento de concepto ([concepts_brief.md](concepts_brief.md))".

### [Issue 21] [`egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Glosario; lines 57, 118, 145, 451, 702
*   **Discrepancy Description:** "Plugs", el orquestador, Temporal, `postWorkflowV112`, autopost y clipping, "el panel", `stripLinks` y "la tarea de cada hora" no están definidos.
*   **Rationale:** El documento no se entiende solo.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Es un hueco de comprensión, y esos hallazgos no se discuten.
*   ***Proposed Edit:*** Agregar filas al glosario:
    *   **Plugs:** acciones automáticas después de publicar. Los internos repostean desde otras cuentas de la organización; los globales actúan sobre la integración, por ejemplo una respuesta automática al llegar a cierto número de likes.
    *   **Orquestador y Temporal:** el servicio que ejecuta los workflows de publicación.
    *   **`postWorkflowV112`:** el workflow vigente que publica un post.
    *   **Tarea horaria:** `missingPostWorkflow`.
    *   **Editor:** se usa en lugar de "el panel".
    *   **`stripLinks`.**
    *   **Autopost y clipping.**

### [Issue 22] [`egm-comprehension`, `egm-style`, `egm-structural`, `egm-design`] - Severity: Medium
*   **Affected Scope:** Line 174; Verification Plan, paso 2
*   **Discrepancy Description:** "Cinco acciones" no coincide con los eventos que produce el recorrido.
*   **Rationale:** El criterio no se puede comprobar.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El recorrido produce siete eventos.
*   ***Proposed Edit:*** "El historial muestra, en orden: `CREATED`, `LINKED_BRIEF`, `SUBMITTED`, `REVIEW_APPROVED`, `FINAL_APPROVED`, `PUBLISHED` y `VERIFIED`." El mismo cambio se aplica en el plan de verificación.

### [Issue 23] [`egm-style`, `egm-comprehension`] - Severity: Medium
*   **Affected Scope:** Lines 797-799, Overview
*   **Discrepancy Description:** Se usa "el jefe" en lugar del nombre del rol, y "Monthly" confunde porque la aprobación es por post.
*   **Rationale:** El mismo rol tiene dos nombres.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Es un problema de consistencia.
*   ***Proposed Edit:*** Cambiar "el jefe" por "el Monthly Reviewer" y agregar al glosario: "Monthly Reviewer: aprobador final de cada post; el nombre viene de que además revisa las analíticas cada mes".

### [Issue 24] [`egm-style`, `egm-comprehension`, `egm-structural`] - Severity: Medium
*   **Affected Scope:** Lines 50-53, 101-103, 104, 369, 603, 695, 745-746, 752, 767, 791, 823, 874-881
*   **Discrepancy Description:** Hay términos que chocan con el glosario, juicios subjetivos y afirmaciones que no se pueden comprobar.
*   **Rationale:** Restan precisión al documento.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Cada caso tiene un reemplazo concreto.
*   ***Proposed Edit:*** Aplicar las propuestas de T-M2, T-M3, T-M6, T-M7, T-M8, T-M10, T-M11, T-M12 y T-M13 de la revisión de estilo:
    *   "en pausa" se define como "pasado a borrador con `changePostStatus('draft')`; se reanuda con `schedule` sin aprobación nueva si la huella no cambió y la fecha es futura";
    *   la alternativa I corrige el nombre a `postSocialInternal` y dice qué piezas del fork se eliminarían si se adopta;
    *   la AGPL queda como "interpretación del equipo, sin revisión legal".

### [Issue 25] [`egm-structural`, `egm-design`] - Severity: Low
*   **Affected Scope:** Lines 205-210
*   **Discrepancy Description:** El CUJ 5 no menciona el `400` de `PUT /status`.
*   **Rationale:** El contrato no está unificado.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El CUJ y la tabla de caminos se contradicen.
*   ***Proposed Edit:*** Separar los dos casos en el "Then": `POST` crea un borrador y devuelve `approvalStage`; `PUT` con `schedule` responde `400`.

### [Issue 26] [`egm-design`] - Severity: Low
*   **Affected Scope:** Lines 89-91, 442-446
*   **Discrepancy Description:** Una fecha pasada en el editor o en `changePostStatus('schedule')` publica de inmediato.
*   **Rationale:** Contradice la meta 7.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Hoy solo `changeDate` rechaza fechas pasadas.
*   ***Proposed Edit:*** `decideBatch` y `beforeChangePostStatus` también exigen una fecha futura para `schedule`. `now` solo se permite en lotes aprobados.

### [Issue 27] [`egm-design`] - Severity: Low
*   **Affected Scope:** Lines 421-438
*   **Discrepancy Description:** No está especificado cómo resuelve `decideBatch` el lote ni cómo se lo pasa al repositorio.
*   **Rationale:** Si no se especifica, el lote se parte.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `createPost` genera un `batchId` nuevo en cada llamada (`posts.service.ts:1155`).
*   ***Proposed Edit:*** "`createPost` pasa `decision.batchId` a `createOrUpdatePost` en lugar del `uuidv4()` nuevo. Si el lote no existía, `decideBatch` genera el id."

### [Issue 28] [`egm-design`] - Severity: Low
*   **Affected Scope:** Lines 390, 528-529
*   **Discrepancy Description:** Si un canal queda en `ERROR`, el lote nunca pasa a `PUBLISHED`.
*   **Rationale:** La verificación de los canales que sí salieron nunca se pide.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Es un caso límite real.
*   ***Proposed Edit:*** El lote pasa a `PUBLISHED` cuando ningún post raíz está en `QUEUE` y al menos uno está en `PUBLISHED`. Los canales en `ERROR` se muestran aparte.

### [Issue 29] [`egm-design`] - Severity: Low
*   **Affected Scope:** Line 417
*   **Discrepancy Description:** `deletePost` no pasa por el punto de control.
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** Borrar no publica nada, así que no hay riesgo. La bandeja ya oculta los lotes borrados porque cruza con los posts que no están borrados.

### [Issue 30] [`egm-design`, `egm-structural`] - Severity: Low
*   **Affected Scope:** Lines 303-359 (Modelo de datos)
*   **Discrepancy Description:** `SYSTEM` no pertenece a `WorkflowRole`, faltan tipos en las tablas y no se explica `BLOCKED`.
*   **Rationale:** El modelo de datos está incompleto.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Son problemas de consistencia.
*   ***Proposed Edit:***
    *   Agregar el enum `ActorRole` con los cuatro roles, `MEMBER` y `SYSTEM`.
    *   Agregar la columna "Tipo" a `PostApprovalEvent`.
    *   Explicar que `BLOCKED` se registra cuando el punto de control cambia `schedule` o `now` por `draft`.

### [Issue 31] [`egm-design`] - Severity: Low
*   **Affected Scope:** Line 357
*   **Discrepancy Description:** El motivo del rechazo vive en `Comments`, una tabla que se puede modificar.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El plan ya copia el texto en `event.reason` (archivo 5, `reject`), pero el modelo de datos no lo dice.
*   ***Proposed Edit:*** Fila `reason`: "obligatorio en `FORCED`, `REJECTED` y `VERIFICATION_PROBLEM`; guarda una copia del texto del comentario".

### [Issue 32] [`egm-design`] - Severity: Low
*   **Discrepancy Description:** Asignar y quitar roles no queda en el historial.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El arreglo del Issue 9 lo resuelve.
*   ***Proposed Edit:*** Ver el Issue 9.

### [Issue 33] [`egm-design`, `egm-comprehension`] - Severity: Low
*   **Affected Scope:** Lines 77-80
*   **Discrepancy Description:** La meta 3 dice que solo el Writer avanza el tema, pero existe `quickBrief`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** "tema (Writer, o un tema rápido del Creator al enviar)". Se aclara también que el tema no es una etapa de `ApprovalStage`.

### [Issue 34] [`egm-design`] - Severity: Low
*   **Affected Scope:** Line 880
*   **Discrepancy Description:** "5 consultas indexadas" se queda corto.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** "5 consultas indexadas, más el cálculo de huellas de los posts en `QUEUE` y una consulta a Temporal por cada post sospechoso".

### [Issue 35] [`egm-design`] - Severity: Low
*   **Affected Scope:** Line 447
*   **Discrepancy Description:** Hay que revisar los consumidores de `approvalStage`.
*   ***AI Suggestion:*** CONTEST
*   ***Justification:*** El plan ya lo exige. El archivo 9, punto 2, dice: "Antes de hacerlo se buscan todos los consumidores de la respuesta (frontend, API pública, herramientas MCP y `updatePostSettings`)". El revisor solo leyó las líneas 1-901 y esa instrucción está en la línea 1205 o cerca.

### [Issue 36] [`egm-design`] - Severity: Low
*   **Discrepancy Description:** TikTok reescribe `image.path` al convertir a JPEG.
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** TikTok está fuera de la v1. Se anotará en Future Improvements cuando se agreguen redes.

### [Issue 37] [`egm-structural`] - Severity: Low
*   **Affected Scope:** Lines 131-161
*   **Discrepancy Description:** La sección "Open Questions" contiene decisiones, no preguntas.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Renombrar a `## Open Questions (resueltas)`, quitar la línea en blanco 142 y enlazar la tabla de etapas.

### [Issue 38] [`egm-structural`] - Severity: Low
*   **Discrepancy Description:** Las referencias de código no tienen todas el mismo formato.
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** Es cosmético y no afecta la comprensión.

### [Issue 39] [`egm-structural`] - Severity: Low
*   **Discrepancy Description:** Falta CLI en la lista de superficies.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Agregar "CLI (usa la API pública)" a la tabla de caminos.

### [Issue 40] [`egm-comprehension`] - Severity: Low
*   **Affected Scope:** Plan, archivo 36
*   **Discrepancy Description:** La descripción de `calendar.tsx:843-844` no coincide con el código.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** El revisor leyó el código: esas líneas deciden si se abre un modal al arrastrar, no cómo se dibuja.
*   ***Proposed Edit:*** "Al arrastrar un post en `QUEUE` con fecha pasada cuyo lote no está `PUBLISHED`, no se muestra el modal de 'ya publicado'."

### [Issue 41] [`egm-style`] - Severity: Low
*   **Discrepancy Description:** Expresiones coloquiales, repeticiones y afirmaciones sin dato (T-N2 a T-N17).
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** Son Nits de redacción. Se pueden aplicar en una pasada final de estilo si lo pides.

---

# Ronda 2: clasificación

La persona dueña del diseño autorizó aplicar en automático ("adelante") los
arreglos de tipo PROPOSE FIX.

| # | Clasificación | Justificación / arreglo |
|---|---|---|
| R2-1 | PROPOSE FIX | Cada vez que cambia la huella, en cualquier etapa, se registra `CONTENT_EDITED` con el actor. Todos los editores desde el último `SUBMITTED` quedan excluidos de aprobar y de forzar. Las ediciones hechas con API key, que no tienen actor, se declaran como riesgo aceptado en la tabla de riesgos. |
| R2-2 | PROPOSE FIX | Si `decideBatch` decidió `draft` o un reinicio, después del bucle vuelve a terminar por ID los workflows de todos los posts raíz del lote. `finalApprove` repite la comprobación de huella después de `startWorkflow` y otra vez un segundo después. La escritura transaccional dentro de `changePostStatus` se descarta, porque ese método es de upstream. |
| R2-3 | PROPOSE FIX | Los archivos multimedia se identifican en la huella por el id de la biblioteca cuando ese id existe en `Media`, y por `path` solo cuando no existe. Con eso, el cambio de `path` que hace el normalizador ya no altera la huella. Además, la conciliación ignora los posts cuya `publishDate` ya llegó, porque se están publicando. Se corrige la mejora futura sobre TikTok. |
| R2-4 | PROPOSE FIX | El lote pasa a `PUBLISHED` solo cuando todos sus posts raíz están en `PUBLISHED`. Se agrega la acción "Descartar canal" (`CHANNEL_DISCARDED`), que borra ese post raíz con `deletePost`. La verificación se pide cuando el lote pasa a `PUBLISHED`. |
| R2-5 | PROPOSE FIX | `force` llama a `changeDate(now)` y después a `changePostStatus('schedule')` con una marca interna, `allowPastDate`, que solo puede pasar `ApprovalService`. La meta 7 lista sus excepciones: el forzado y la tarea de cada hora. |
| R2-6 | PROPOSE FIX | Un cuerpo con solo algunos canales no cuenta como quitar canales. Solo se comparan los canales que vienen en el cuerpo. Los que no vienen pasan a `DRAFT` únicamente si hay reinicio, por la decisión ya tomada de reiniciar el lote entero. Se agrega una prueba de `updatePostSettings` sobre un lote de 3 canales. |
| R2-7 | SETTLED (no se reabre) | El riesgo aceptado del workflow dormido ya quedó decidido en la etapa 5 y en el borrador. Sí se aplica la parte que es nueva: la ventana del riesgo queda cuantificada en la tabla (hasta 15 minutos; un post con hora de publicación dentro de esa ventana se publica con seguridad), y la variante en `getPostsList` se registra en la alternativa I como opción para reconsiderar. |
| R2-8 | PROPOSE FIX | Se reemplaza `:NN` por `#LNN` en todos los enlaces. |
| R2-9 | PROPOSE FIX | Se quita el enlace y se aclara que `docs/fork/runbook.md` se crea en el archivo 51 del plan. Lo mismo para `FORK_TOUCHPOINTS.md` y para el script. |
| R2-10 | PROPOSE FIX | El glosario pasa a un `## Glosario` propio, después del Overview, y se agrega la definición de "conciliación". |
| R2-11 | PROPOSE FIX | La meta 3 indica junto a cada paso su `stage` o su `Post.state`, y menciona `CHANGES_REQUESTED` y `VERIFICATION_PROBLEM`. |
| R2-12 | PROPOSE FIX | Se agregan a la tabla de riesgos una fila de escala y una de la AGPL. La AGPL pasa a ser la única pregunta abierta. |
| R2-13 | PROPOSE FIX | El Overview, The Problem y la meta 1 remiten a la tabla. Se agrega a la tabla la fila "Reintento de un canal en `ERROR`". |
| R2-14 | PROPOSE FIX | Se reescribe la frase. |
| R2-15 | PROPOSE FIX | Se agrega en Goals una nota: en el flujo, "post" significa el lote completo. Las metas 5 y 7 pasan a decir "lote". |
| R2-16 | PROPOSE FIX | "Brief" se usa para `ContentBrief` y "tema" solo para el campo `topic`. |
| R2-17 | PROPOSE FIX | Se escribe "terminar (terminate)" en todo el documento y se define en el glosario. |
| R2-18 | PROPOSE FIX | Se agrega el antecedente de "esta copia". |
| R2-19 | PROPOSE FIX | "Cada 96 vueltas (24 h) o con más de 1000 eventos de historial, igual que `missingPostWorkflow`." |
| R2-20 | PROPOSE FIX | La conciliación al arrancar registra `RECONCILED` con `reason: 'startup'` y no cuenta como alerta. La alerta es cualquier `RECONCILED` de la tarea periódica. |
| R2-21 | PROPOSE FIX | Cada riesgo residual se describe con la condición que lo produce. |
| R2-22 | PROPOSE FIX | La conciliación al arrancar no bloquea el arranque (corre en segundo plano y reintenta 3 veces). Con varias réplicas es idempotente. Si `APPROVALS_ENABLED=true` y no está `RUN_CRON`, el backend escribe un error en el log. |
| R2-23 | PROPOSE FIX | Se usa una sola consulta `ExecutionStatus="Running"` por organización, cruzada con los posts en `DRAFT`. "Sospechoso" se define como "post raíz en `DRAFT` con un workflow corriendo". |
| R2-24 | PROPOSE FIX | Se aclara que deja de estar vencido cuando todos los posts raíz tienen una fecha futura. El CUJ 4 dice que se arrastran todos los canales. |
| R2-25 | PROPOSE FIX | Los avisos van a los roles de la etapa actual del lote. |
| R2-26 | PROPOSE FIX | Se agrega una nota: el link sirve solo para miembros; la descripción del tool no cambia en la v1. |
| R2-27 | PROPOSE FIX | Se define la normalización: `delay` vale 0 por defecto, los valores vacíos se tratan como ausentes, se ignora `__type` y las claves van ordenadas. |
| R2-28 | PROPOSE FIX | `findBatchIdFor` usa el mismo criterio que el repositorio, que siempre prefiere `existingBatchId`. Se agrega una prueba que comprueba que los dos resultados coinciden. |
| R2-29 | PROPOSE FIX | Se usa "## Risks & Mitigations", se agrega un H3 para el riesgo aceptado y "## Open Questions" queda con la AGPL y una subsección de decisiones. |
| R2-30 | PROPOSE FIX | Se aclara la nota sobre las rutas, la explicación de la pausa pasa a una nota debajo de la tabla y se usa siempre `FORK_TOUCHPOINTS.md`. |
| R2-31 | DECLINE | Es cosmético. |
| R2-32 | DECLINE | Son Nits de redacción. Solo se aplican los que tocan frases que ya se editan por otros arreglos. |

**Estado de la ronda 2: resuelta.**

*   **Aplicados:** 28 PROPOSE FIX (R2-1 a R2-6 y R2-8 a R2-30). De R2-7 se
    aplicó solo la parte que era nueva: la cuantificación y la variante de
    `getPostsList`.
*   **Sin cambios:** R2-7 quedó como hallazgo ya decidido (SETTLED), y R2-31 y
    R2-32 como DECLINE.

**Convergencia:** las rondas 1 y 2 no fueron limpias. Para converger hacen falta
dos rondas limpias seguidas, y el límite es de 5 rondas.

---

# Ronda 3: clasificación y resolución

El dueño pidió "Aplicar y ronda 4".

## Corregidos (PROPOSE FIX aplicado)

*   **Diseño:**
    *   D1 (Blocker): la autoría pasa a incluir `CREATED`, `SUBMITTED` y
        `CONTENT_EDITED` en cualquier etapa.
    *   D2: `republish: true` se rechaza solo en `PUBLISHED`.
    *   D3: "un post raíz en `PUBLISHED` nunca vuelve a `QUEUE`" pasa a ser
        parte de la regla central y se aplica en los tres métodos.
    *   D4: `changeDate('update')` sobre un post en `QUEUE` se convierte en
        `schedule`.
    *   D5: la conciliación también baja a `DRAFT` los posts en `QUEUE` con la
        hora pasada y sin workflow. El riesgo aceptado ahora describe ese caso.
    *   D6: una sola regla para borrar canales. "Descartar canal" no reinicia;
        borrar otro canal sí reinicia. `deletePost` pasa por el punto de
        control.
    *   D7: las acciones del flujo responden `403` cuando hay suplantación.
    *   D8: se cubre con la autoría de D1.
    *   D9: la huella aplica las mismas reglas que `updateMedia` y cuenta las
        filas de `Media` con `deletedAt`.
    *   D10: la conciliación crea un `PostApproval` para los lotes que no lo
        tienen.
    *   D11: se unificó el costo de la conciliación y se agregaron índices.
    *   D12: se quitó la comprobación "un segundo después".
    *   D13: el `html` de los avisos lleva solo la etapa, el tema y el link.
*   **Estructura:**
    *   S1: "Decisiones tomadas" pasa a ser un H2.
    *   S2: la tabla de riesgos tiene su propio H3.
    *   S3: se corrigió el diagrama.
    *   Nit 4: nota sobre los encabezados en español.
    *   Nit 7: rangos en las anclas `#La-Lb`.
    *   Nit 8: enlaces al plan.
    *   Nit 11: AGPL sin duplicar.
*   **Estilo:**
    *   T1: diagrama.
    *   T2: razón de `shortLink`.
    *   T3: "de todos modos".
    *   T4: cita de la meta 1.
    *   T5: "punto de control" entra al glosario y se unifica el término.
    *   T6: una sola consulta a Temporal por organización.
    *   T7: motivos de las alternativas N y P.
    *   T8: se usa "post raíz" en los riesgos.
    *   Nits aplicados: N3, N4, N8, N10, upstream y Writer en el glosario.

## Rechazados (DECLINE, todos Nit)

*   S5: mover "Solución propuesta".
*   S6: referencias sin enlace.
*   S9: largo de línea.
*   S10: separadores.
*   S12: "Instalación inicial".
*   S13: "Variante sin evaluar".
*   T N1, N2, N5, N6, N7, N9, N11, N12 y el resto de N13.

**Estado:** resuelto. La ronda 4 sigue.

---

# Ronda 4: resolución y cierre de la etapa 7

El dueño pidió: "Aplicar y etapa 8".

## Aplicados

*   **Diseño:** el Blocker B1 (puertos 7233 y 8080 de Temporal), M1 a M7, y los
    Nits N1 a N4, N6, N7 y N8.
*   **Estructura:**
    *   M1: la variante en `getPostsList` queda evaluada y rechazada junto con
        la alternativa I.
    *   M2: la tabla de transiciones agrega pausar, reanudar y reintentar,
        separa la fila del cambio de contenido y unifica la columna "Desde".
    *   M3: se agregan las alternativas W, X, Y y Z.
*   **Estilo:** M1 a M3, y los Nits N9, N15, N16, N17, N18 y N24.

## Rechazados (DECLINE)

Los Nits restantes de redacción y formato, y el presupuesto separado de N5.

## Cierre de la etapa 7

*   **Resultado:** cerrada después de 4 rondas, sin converger. Ninguna ronda
    quedó limpia.
*   **Lo que se aceptó:** la persona dueña del diseño decidió pasar a la etapa 8
    sin ejecutar la ronda 5.
*   **Riesgos residuales aceptados:**
    *   el "Riesgo aceptado: workflow dormido";
    *   los caminos de borrado de Postiz que ignoran el error;
    *   la suplantación usada para editar;
    *   la dependencia de una dotación mínima de aprobadores.

    Todos están documentados en Risks & Mitigations.
*   **Pendiente para la etapa 9:** volver a comprobar el plan de implementación
    contra el código.
