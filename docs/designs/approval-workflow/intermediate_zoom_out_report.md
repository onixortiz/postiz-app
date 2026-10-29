# Etapa 8: Zoom Out intermedio

*   **Documento:** `docs/designs/approval-workflow.md` (completo, 2370 líneas).
*   **Revisor:** `egm-zoom-out`, sin acceso a la conversación. Recibió como
    contexto `zoom_out_report.md`.
*   **Fecha:** 2026-10-28

## Veredicto

**El diseño necesita cambios.** No hay Blockers. Hay 6 Major y 4 Nit.

La idea central sigue siendo correcta y está a la altura adecuada: nada sin
aprobar sale de `DRAFT`, y eso se aplica en la capa de servicio. Tres de las
mitigaciones nuevas son proporcionadas y se mantienen tal como están:

*   el campo `version`;
*   el cierre de los puertos 7233 y 8080;
*   el bloqueo de las acciones del flujo durante la suplantación.

**Diagnóstico del revisor.** Casi todas las capas que se agregaron en la etapa 7
compensan dos compromisos que se aceptaron en la etapa 5:

*   **R1**, decidir antes de escribir;
*   la **decisión A**, no tocar el orquestador.

El costo de esos dos compromisos ya no es el que se evaluó entonces.

**Comprobado en el código:**

*   `getPostsList` corre después del `sleep`, incluso con `postNow`
    (`post.workflow.v1.1.2.ts:182`). Si devuelve `[]`, el workflow termina en
    `ERROR 'No Post'` antes de publicar.
*   `startWorkflow` ya termina workflows en cada guardado
    (`posts.service.ts:944-975`).
*   El middleware solo suplanta cuando se cumple `user.isSuperAdmin && impersonate`
    (`auth.middleware.ts:60-68`).

## Hallazgos

| # | Severidad | Tema | Cambio sugerido | ¿Reabre una decisión? |
|---|---|---|---|---|
| 1 | 🟡 Major | Decidir antes de escribir (R1) obliga a reproducir en `normalizeFromBody` siete reglas de equivalencia. Una de ellas, la copia de `updateMedia`, no está en `FORK_TOUCHPOINTS.md`. La alternativa W tiene un argumento circular. | Reabrir R1: guardar como `draft`, calcular la huella solo desde las filas y después pasar a `QUEUE`. Así desaparecen `normalizeFromBody`, la copia de `stripLinks`, el forzado de `shortLink`, `findBatchIdFor` y la alternativa W. **Mínimo, si R1 se mantiene:** registrar la copia de `updateMedia` en `FORK_TOUCHPOINTS.md`. | **Sí: R1** (etapa 5, aceptado) |
| 2 | 🟡 Major | Hoy hay seis mecanismos de concurrencia en cuatro secciones, y existen solo porque la comprobación no está en el último punto antes de publicar. La variante `getPostsList` (unas pocas líneas en el cuerpo de una actividad, algo que `CLAUDE.md` permite) cerraría el riesgo del workflow dormido, el acceso con `postNow` y las carreras entre aprobación y edición. | Adoptar la variante `getPostsList` en la v1 y quitar la segunda terminación, el paso 6 de `finalApprove` y el margen de 2 minutos. **Si se mantiene el rechazo:** actualizar la cuenta de costos de la alternativa I y juntar la historia de concurrencia en una sola subsección. | **Sí: decisión A** |
| 3 | 🟡 Major | La regla de autoría está escrita de tres formas. El archivo 5 (`force`) dice todavía "`RESET_BY_EDIT` desde el último `SUBMITTED`", y la meta 8 habla de "la versión actual". | Dejar una sola definición, la del glosario, y que los demás lugares la citen. Corregir `force`. | No |
| 4 | 🟡 Major | La "huella de referencia" está definida de tres formas que no coinciden. Además, `force` también llena `approvedFingerprints`. | Escribir una sola definición en "Huella del contenido". | No |
| 5 | 🟡 Major | No está claro qué hace la conciliación ante `fingerprint_drift`: si desprograma el lote, si registra los dos eventos, y si avisa a los ADMIN. | Escribir la conciliación como una tabla de condición, acción, evento y alerta, y alinear con ella Observabilidad y Future Improvements. | No |
| 6 | 🟡 Major | "Descartar canal" repite lo que ya hace `deletePost`, y su restricción de rol no protege nada. | `beforeDeletePost` registra `CHANNEL_DISCARDED`. Se quitan el endpoint, el DTO y la regla de rol. | No |
| 7 | 🟢 Nit | La condición de suplantación no coincide con la del middleware, porque le falta `isSuperAdmin`, y no está en `FORK_TOUCHPOINTS.md`. | Usar `user.isSuperAdmin && impersonate` y registrarla. | No |
| 8 | 🟢 Nit | La fila "el bucle falla a la mitad" no coincide con lo que hace el `finally` cuando no hay reinicio: el lote queda "en pausa", no "en revisión". | Corregir la fila y explicar cómo se reanuda. | No |
| 9 | 🟢 Nit | W y X no son alternativas técnicas. | Mover X a "Decisiones tomadas". Quitar W si se aplica el hallazgo 1. | No |
| 10 | 🟢 Nit | No hay un CUJ para el caso en que un Reviewer corrige una coma y queda excluido. | Agregarlo al CUJ 3 o a la fila de riesgo. | No |

## Nota del Elephant

Los hallazgos 3 y 4 confirman que quedaron restos de la etapa 7: en la ronda 4
corregí la meta 4 y el archivo 3, pero no la meta 8 ni `force` en el archivo 5.
Son errores del documento y se corrigen sin decisiones nuevas.

Los hallazgos 1 y 2 reabren dos decisiones que la persona dueña del diseño ya
aceptó (R1 y A). El argumento ahora es más fuerte que en la etapa 5, porque se
apoya en todo lo que se agregó después. La decisión sigue siendo de la persona
dueña del diseño.

## Cierre de la etapa 8

La persona dueña del diseño eligió pasar a la etapa 9 sin aplicar cambios. Los
hallazgos 1 a 10 quedan **pendientes**:

*   los hallazgos 1 y 2 (R1 y la decisión A) siguen sin reabrir;
*   los hallazgos 3 a 10 son correcciones que todavía no se hicieron.
