# Etapa 6: prueba de comprensión

*   **Documento:** `docs/designs/approval-workflow.md`
*   **FeatureRange:** líneas 1 a 901.
*   **DetailedRange:** líneas 902 a 1688.
*   **Revisor:** `egm-comprehension`. No tiene acceso a la conversación y no
    se aplica ningún estándar de documento.
*   **Fecha:** 2026-10-28

## What this proposes

Se propone un fork de Postiz para un equipo interno. El fork agrega cuatro roles
de trabajo (Technical Writer, Creator, Reviewer y Monthly Reviewer), guardados en
tablas propias.

También agrega una cadena de aprobación: tema, producción, revisión, aprobación
final, publicación y verificación.

El bloqueo es una sola regla. Un post solo puede estar en `QUEUE` si se cumplen
dos condiciones:

*   su lote (el mismo contenido para varios canales) está aprobado;
*   la huella SHA-256 de su contenido no cambió desde la aprobación.

`ApprovalGateService` aplica esa regla antes de que escriban los cuatro métodos
de `PostsService`, así que todo lo que no está aprobado se queda en `DRAFT`.
Las acciones de aprobación solo se hacen desde la web, con sesión iniciada.

Un workflow nuevo de Temporal corre cada 15 minutos. Avisa de los vencimientos,
marca los lotes publicados y devuelve a `DRAFT` cualquier post en `QUEUE` sin
aprobación.

El documento acepta que queda un hueco pequeño, porque no se toca el
orquestador.

## How the existing system works, per this document

En Postiz, cualquier miembro puede programar un post. Al pasar a `QUEUE` se
inicia un workflow de Temporal (`postWorkflowV112`) que duerme hasta la hora y
publica. Un post en `DRAFT` nunca inicia un workflow, y la tarea que corre cada
hora solo mira los posts en `QUEUE`.

Sin Stripe, los permisos CASL (`@CheckPolicies`) no frenan a nadie.

Hay varios caminos para programar un post: el editor, el calendario, la API
pública, el SDK y MCP. Otros publican sin pasar por la pantalla: los posts
repetidos y los plugs.

Los posts de varios canales comparten `batchId`, que se mantiene entre
guardados. `group`, en cambio, cambia en cada guardado.

El revisor pudo parafrasear todas las secciones, así que no hay Blockers por
falta de comprensión.

## Hallazgos

| # | Severidad | Dónde | Problema |
|---|---|---|---|
| 1 | 🟡 Major | Transiciones (381-386), `decideBatch` (1032-1038), `reviewApprove` (1091-1095) | **Un lote editado durante la revisión no tiene salida definida.** Al editarlo en `IN_REVIEW` o `AWAITING_FINAL` vuelve a `IN_REVIEW`, pero no se crea un `SUBMITTED` nuevo. Entonces `reviewApprove` nunca coincide con la huella, y reenviar solo se permite desde `IN_PRODUCTION` o `CHANGES_REQUESTED`. Tampoco se dice si cada guardado en `IN_REVIEW` reinicia de nuevo y vuelve a avisar. |
| 2 | 🟡 Major | 471, 643, 1182 | **"Decisión A" y "Alternativa A" usan la misma letra.** La decisión A es aceptar el hueco; la alternativa A, rechazada, es el servicio aparte. |
| 3 | 🟡 Major | 133, 632, glosario (231) | **"Brief" tiene dos significados.** A veces es el documento de requisitos anterior, que no está enlazado, y a veces es el `ContentBrief`. |
| 4 | 🟡 Major | CUJ 1 (174), Verification Plan paso 2 (1674) | **"Cinco acciones" no se puede comprobar.** El recorrido produce siete eventos: `CREATED`, `LINKED_BRIEF`, `SUBMITTED`, `REVIEW_APPROVED`, `FINAL_APPROVED`, `PUBLISHED` y `VERIFIED`. |
| 5 | 🟡 Major | 57, 118, 453, 1213, 1303 | **"Plugs" no está definido.** No se dice qué son, cuándo se disparan ni en qué se diferencian los internos de los globales. |
| 6 | 🟡 Major | Non-Goals (127-129) frente a "Instalación inicial" (632-635) | **Contradicción:** una parte dice "solo se incluye un script" y la otra dice "no hace falta un script aparte". |
| 7 | 🟡 Major | Forzar (385, 997, 1112-1117) | **No está claro qué se salta al forzar.** ¿Aplica la regla de no aprobarse a sí mismo? Un Monthly Reviewer que además es Creator podría forzar su propio lote. ¿Se ejecuta `validatePosts`? |
| 8 | 🟢 Nit | Etapas (369) | `APPROVED` con `DRAFT` "en pausa": no se dice cómo se llega a ese estado, cómo se reanuda ni si reanudar exige aprobación. |
| 9 | 🟢 Nit | Archivo 36 (1446-1448) | "Corrige el caso de las líneas 843-844" no coincide con el código. Esas líneas deciden si se abre un modal al arrastrar un post publicado o en `QUEUE` con fecha pasada; no dibujan el estado. |
| 10 | 🟢 Nit | 145, 411, 451, 605, 702, 782 | Hay términos de Postiz sin definir: el orquestador y Temporal, `postWorkflowV112`, autopost, clipping y el generador, "el panel", `stripLinks` y "la tarea de cada hora" (`missingPostWorkflow` y `RUN_CRON`). |
| 11 | 🟢 Nit | 797-799 | "Monthly Reviewer" aprueba cada post, no una vez al mes. Además, en la alternativa O aparece "el jefe" sin decir que es el mismo rol. |
| 12 | 🟢 Nit | Meta 3 (77-80) frente a la transición (380) | El "tema (Writer)" no es una etapa, el primer guardado lo puede hacer cualquiera, y existe el `quickBrief`. |
| 13 | 🟢 Nit | The Problem (51-59) | Dice "al menos seis caminos" sin enumerarlos. Habría que remitir a la tabla. |

## Resumen del revisor

El documento se entiende bien en general.

*   **Lógica que no cierra:**
    *   el reinicio durante la revisión (1);
    *   forzar la publicación (7).
*   **Contradicción:** la del script de instalación (6).
*   **Criterio que no se puede comprobar:** las "cinco acciones" del historial
    (4).
*   **Ambigüedades de nombre:** "decisión A" (2) y "brief" (3).
*   **Término sin definir:** "plugs" (5).

## Nota del Elephant

Los hallazgos 1, 4, 6 y 7 son errores del documento, no solo de redacción.

*   **Hallazgo 1.** Aparece porque la segunda pasada de la etapa 5 quitó
    `reviewerApprovedFingerprints` y la referencia pasó a leerse de los
    eventos, pero ningún evento se crea al reiniciar.
*   **Hallazgo 6.** Es un resto de la conciliación con el brief: el borrador
    cambió la sección "Instalación inicial", pero los Non-Goals se quedaron
    con el texto anterior.

La etapa 6 no aplica cambios. Pueden corregirse en la etapa 7 o editando el
documento.
