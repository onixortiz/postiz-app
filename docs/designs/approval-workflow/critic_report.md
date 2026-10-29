# Etapa 7: revisión crítica, ronda 1

*   **Documento:** `docs/designs/approval-workflow.md`, FeatureRange (líneas 1 a
    901).
*   **Revisores:** cada uno sin acceso a la conversación.

    | Revisor | Estándar | Estado | Hallazgos |
    |---|---|---|---|
    | `egm-design` | `feature-spec-standard` | completado | 13 Major, 14 Nit |
    | `egm-structural` | `feature-spec-standard` | completado | 9 Major, 9 Nit |
    | `egm-style` | solo su persona | completado | 1 Blocker, 13 Major, 18 Nit |

*   **Hallazgos de la etapa 6 que siguen abiertos:** C1 a C13 de
    `comprehension_report.md`. Se cruzaron con los de esta ronda.
*   **Fecha:** 2026-10-28

## Verificaciones del Elephant contra el código

| Afirmación del revisor | Resultado | Evidencia |
|---|---|---|
| `InfiniteWorkflowRegisterModule` vive en el backend, no en el orquestador. | Confirmado | `apps/backend/src/app.module.ts:17,34` |
| `MediaDto` tiene `alt` y `thumbnail`. | Confirmado | `libraries/nestjs-libraries/src/dtos/media/media.dto.ts:15-21` |
| El preview lee los comentarios de `/public/posts/:id/comments`. | Confirmado | `preview.comments.context.tsx:45-48`, `comments.components.tsx:197` |
| `sendEmailsToOrg` se salta a los usuarios con `sendSuccessEmails = false`; el tipo `'info'` se envía siempre. | Confirmado | `notification.service.ts:94-104` |
| `createPost` crea un `batchId` nuevo en cada llamada, y MCP llama una vez por canal. | Confirmado | `posts.service.ts:1155`, `integration.schedule.post.ts:249-285` |
| `postWorkflowV112` usa `postSocialPending`. | Confirmado (etapa 5) | `post.workflow.v1.1.2.ts:442` |

## Lista consolidada (sin duplicados)

Los ids de origen indican quién lo encontró:

*   **D:** `egm-design`
*   **S:** `egm-structural`
*   **T:** `egm-style`
*   **C:** etapa 6

La clasificación y el arreglo propuesto de cada uno están en
`goldfish_review_report.md`.

| # | Severidad | Tema | Origen |
|---|---|---|---|
| 1 | 🔴 Blocker | El Overview, la meta 1 y la línea 246 prometen algo absoluto que el riesgo aceptado contradice. | T-B1 (antes R2 en la etapa 5) |
| 2 | 🟡 Major | Carrera entre la aprobación final y una edición simultánea. | D-M1 |
| 3 | 🟡 Major | La cancelación con `list()` no ve los workflows recién creados (visibilidad con retraso en Elasticsearch). | D-M2 |
| 4 | 🟡 Major | Reaprobar o forzar un lote republica los canales que ya se publicaron. | D-M3 |
| 5 | 🟡 Major | Forzar: no dice si guarda huellas, si ejecuta `validatePosts` ni qué fecha usa. Además, permite forzar el lote propio. | D-M4, D-M6, S-M4, C7 |
| 6 | 🟡 Major | Una persona puede aprobarse a sí misma editando, y no está definida la referencia después de un reinicio. | D-M5, S-M5, C1 |
| 7 | 🟡 Major | La huella deja fuera `alt` y `thumbnail`, e incluye el `id` de la media, que cambia en MCP. | D-M7, S-N9 |
| 8 | 🟡 Major | `RUN_CRON` y "corre al arrancar el orquestador" no coinciden con el código. Riesgo al reactivar el interruptor. | D-M8, S-N8 |
| 9 | 🟡 Major | Un índice único parcial no se puede expresar con Prisma `db push`. | D-M9, S-M7 |
| 10 | 🟡 Major | El preview con sesión pierde la lectura de comentarios. | D-M10 |
| 11 | 🟡 Major | Los avisos de equipo con tipo `success` pueden no llegarle a nadie. | D-M11 |
| 12 | 🟡 Major | La única alerta del riesgo aceptado depende de Sentry, que es opcional. | D-M12 |
| 13 | 🟡 Major | Falta la sección "Riesgos y mitigaciones". | D-M13, S-M1 |
| 14 | 🟡 Major | Por MCP, un mismo post en varias redes queda en lotes separados. | S-M6 |
| 15 | 🟡 Major | El paso 4 de la tarea de mantenimiento no es idempotente. | S-M8 |
| 16 | 🟡 Major | El runbook no está enlazado, y quitar el bloque del esquema hace fallar el arranque. | S-M9, T-N1, D-N13 |
| 17 | 🟡 Major | "Future Improvements" está en nivel H3, dentro de NFR. | S-M2, T-N18 |
| 18 | 🟡 Major | Los Non-Goals y la sección "Instalación inicial" se contradicen sobre el script. | S-M3, C6 |
| 19 | 🟡 Major | "Decisión A" choca con "Alternativa A". | T-M5, C2 |
| 20 | 🟡 Major | "Brief" tiene dos significados. | T-M1, C3 |
| 21 | 🟡 Major | "Plugs" y otros términos de Postiz no están definidos. | C5, C10 |
| 22 | 🟡 Major | "Cinco acciones" no se puede comprobar. | C4, T-M9, S-N4, D-N9 |
| 23 | 🟡 Major | Se usa "el jefe" en lugar de "Monthly Reviewer", y el nombre del rol confunde. | T-M4, C11 |
| 24 | 🟡 Major | Redacción: "etapas" de Docker, "estados parciales", "no se filtra", "en pausa", "seis caminos", plazo de la meta 11, juicios subjetivos, motivo de la alternativa I, AGPL y "medible". | T-M2, T-M3, T-M6, T-M7, C8, T-M8, C13, S-N3, T-M10, T-M11, T-M12, T-M13 |
| 25 | 🟢 Nit | CUJ 5 frente al `400` de `PUT /status`. | S-N5, D-N1 |
| 26 | 🟢 Nit | Una fecha pasada en el editor o en `changePostStatus` publica de inmediato. | D-N2 |
| 27 | 🟢 Nit | `decideBatch` tiene que pasar el `batchId` al repositorio. | D-N3 |
| 28 | 🟢 Nit | Si un canal queda en `ERROR`, el lote nunca llega a `PUBLISHED`. | D-N4 |
| 29 | 🟢 Nit | Quitar un canal con `deletePost` no pasa por el punto de control. | D-N5 |
| 30 | 🟢 Nit | `SYSTEM` no pertenece a `WorkflowRole`; faltan tipos en las tablas; `BLOCKED` no está explicado. | D-N6, S-N6 |
| 31 | 🟢 Nit | El motivo del rechazo vive en `Comments`, que se puede modificar. | D-N7 |
| 32 | 🟢 Nit | Asignar y quitar roles no queda en el historial. | D-N8 |
| 33 | 🟢 Nit | La meta 3 frente a `quickBrief`. | D-N10, C12 |
| 34 | 🟢 Nit | "5 consultas indexadas" se queda corto. | D-N11 |
| 35 | 🟢 Nit | Hay que revisar los consumidores de `approvalStage`. | D-N12 |
| 36 | 🟢 Nit | TikTok reescribe `image.path`. | D-N14 |
| 37 | 🟢 Nit | La sección "Open Questions" contiene decisiones. | S-N2 |
| 38 | 🟢 Nit | Formato de las referencias de código. | S-N7 |
| 39 | 🟢 Nit | Falta CLI en la lista de superficies. | S-N9 |
| 40 | 🟢 Nit | La descripción de `calendar.tsx:843-844` no coincide con el código. | C9 |
| 41 | 🟢 Nit | Expresiones coloquiales, repeticiones y afirmaciones sin dato. | T-N2 a T-N17 |

---

# Ronda 2

| Revisor | Estado | Hallazgos |
|---|---|---|
| `egm-design` | completado | 7 Major y 9 Nit |
| `egm-structural` | completado | 5 Major y 7 Nit |
| `egm-style` | completado | 9 Major y 18 Nit |

**La ronda no está limpia:** quedan Major nuevos sin resolver.

**Verificado por el Elephant:**

*   `updateMedia` reescribe `path` cuando el normalizador cambió el archivo
    (`posts.service.ts:524-528`). Se llama desde `groupForEditor`, en la línea
    745, y al publicar, en `post.activity.ts:247` y `:391`.
*   `missingPostWorkflow` hace `continueAsNew` cada 24 vueltas o cuando el
    historial pasa de 1000 eventos (`missing.post.workflow.ts:25-29`).

| # | Severidad | Tema | Origen |
|---|---|---|---|
| R2-1 | 🟡 Major | Las ediciones en `IN_PRODUCTION` o `CHANGES_REQUESTED`, o hechas con API key, no dejan autor, así que quien las hizo podría aprobar después. | D2-M1 |
| R2-2 | 🟡 Major | Una edición que llega mientras se ejecuta la aprobación final puede dejar vivo un workflow que la búsqueda de Temporal todavía no ve. | D2-M2 |
| R2-3 | 🟡 Major | `updateMedia` reescribe `path`, lo que cambia la huella sin que nadie edite y provoca `RECONCILED` falsos, incluso a mitad de una publicación. | D2-M3 |
| R2-4 | 🟡 Major | El paso automático a `PUBLISHED` impide reintentar los canales en `ERROR` y deja sin salida los canales en pausa. | D2-M4 |
| R2-5 | 🟡 Major | No está definido el mecanismo para forzar con fecha pasada, y eso contradice la meta 7. | D2-M5 |
| R2-6 | 🟡 Major | No está claro si un cuerpo que trae solo algunos canales cuenta como quitar los demás. | D2-M6 |
| R2-7 | 🟡 Major | El riesgo aceptado no está cuantificado. Se propone una variante de la alternativa I en `getPostsList`. | D2-M7 |
| R2-8 | 🟡 Major | Los enlaces `archivo:línea` dan 404 en GitHub. | S2-M1 |
| R2-9 | 🟡 Major | El enlace a `docs/fork/runbook.md` está roto. | S2-M2, D2-N5 |
| R2-10 | 🟡 Major | El glosario aparece después de que se usan sus términos, y falta definir "conciliación". | S2-M3 |
| R2-11 | 🟡 Major | La meta 3 no coincide con la tabla de etapas. | S2-M4 |
| R2-12 | 🟡 Major | A la tabla de riesgos le faltan el riesgo de escala y el de la AGPL. | S2-M5, D2-N6 |
| R2-13 | 🟡 Major | La lista de caminos está repetida en tres lugares y no coincide; "reintentos" no está en la tabla. | T2-M1 |
| R2-14 | 🟡 Major | Una frase con doble negación en el Overview. | T2-M2 |
| R2-15 | 🟡 Major | Se alternan "post" y "lote" para la unidad de aprobación. | T2-M3 |
| R2-16 | 🟡 Major | Se alternan "tema" y "brief". | T2-M4 |
| R2-17 | 🟡 Major | Se dice "cancelar" donde la operación de Temporal es "terminar". | T2-M5 |
| R2-18 | 🟡 Major | "Esta copia" no tiene antecedente. | T2-M6 |
| R2-19 | 🟡 Major | "Cada cierto número de vueltas" no es un dato medible. | T2-M7 |
| R2-20 | 🟡 Major | "Cualquier `RECONCILED`" y "`RECONCILED` real" no están definidos. | T2-M8 |
| R2-21 | 🟡 Major | Los riesgos residuales "Bajo" y "Ninguno" no tienen criterio. | T2-M9 |
| R2-22 | 🟢 Nit | La conciliación al arrancar: si bloquea el arranque, qué pasa con varias réplicas y qué pasa si falta `RUN_CRON`. | D2-N1 |
| R2-23 | 🟢 Nit | "Post sospechoso" no está definido. | D2-N2, T2 |
| R2-24 | 🟢 Nit | Un lote vencido no deja de estarlo al arrastrar un solo canal. | D2-N3 |
| R2-25 | 🟢 Nit | No se dice a quién llegan los avisos de 48 h y 24 h. | D2-N4 |
| R2-26 | 🟢 Nit | El `previewUrl` que devuelve MCP con `?share=true` deja de servir para compartir. | D2-N7 |
| R2-27 | 🟢 Nit | Faltan los valores por defecto en la normalización de la huella. | D2-N8 |
| R2-28 | 🟢 Nit | El lote se decide en dos lugares (`existingBatchId`). | D2-N9 |
| R2-29 | 🟢 Nit | Los encabezados mezclan idiomas, la sección se llama "Open Questions (resueltas)" y el riesgo aceptado no tiene ancla propia. | S2-N1, S2-N2, S2-N3, T2-N1 |
| R2-30 | 🟢 Nit | La nota sobre las rutas es ambigua, la celda de `APPROVED` es demasiado larga y el nombre `FORK_TOUCHPOINTS` no es uniforme. | S2-N5, S2-N6, S2-N7, T2-N14 |
| R2-31 | 🟢 Nit | Referencias de código sin enlace. | S2-N4 |
| R2-32 | 🟢 Nit | Expresiones coloquiales, repeticiones y regionalismos. | T2-N2 a T2-N18 |

---

# Ronda 3

| Revisor | Estado | Hallazgos |
|---|---|---|
| `egm-design` | completado | 1 Blocker, 9 Major y 3 Nit |
| `egm-structural` | completado | 3 Major y 10 Nit |
| `egm-style` | completado | 8 Major y 13 Nit |

**No está limpia.** Además se detectó **churn**: dos hallazgos nuevos están en el
mismo lugar que arreglos de la ronda 1 o 2, y deshacer esos arreglos los
resolvería.

*   **R3-D2.** Rechazar siempre `republish: true` rompe el arrastre en el
    calendario, porque `calendar.tsx:917` manda esa bandera en todo arrastre con
    `schedule`. La regla la agregó el arreglo del Issue 4 de la ronda 1.
*   **R3-D6.** "Descartar canal" deja el lote en `APPROVED`, pero "quitar un
    canal" reinicia el lote. Las dos reglas son de la ronda 2 (R2-4 y R2-6) y se
    contradicen entre sí.

**Verificado por el Elephant:**

*   `calendar.tsx:917` manda `republish: true` en todo `schedule`.
*   `auth.middleware.ts:60-75` deja que un superadmin suplante a otro usuario.
*   `posts.controller.ts:303` usa `action = 'update'` por defecto.

## Hallazgos abiertos (Blocker y Major)

| # | Severidad | Tema |
|---|---|---|
| R3-D1 | 🔴 Blocker | Quien crea un lote puede forzarlo él solo desde `IN_PRODUCTION`, porque `CREATED` no cuenta como autoría. |
| R3-D2 | 🟡 Major (churn) | Rechazar `republish: true` rompe el arrastre en el calendario de los CUJ 3 y 4. |
| R3-D3 | 🟡 Major | `changeDate('update')` y después `changePostStatus('schedule')` republican un canal ya publicado. "Nunca vuelve a `QUEUE`" no es una regla propia del punto de control. |
| R3-D4 | 🟡 Major | `changeDate('update')` en un post en `QUEUE` deja el workflow dormido con la hora anterior. |
| R3-D5 | 🟡 Major | La conciliación ignora los posts en `QUEUE` con la hora pasada, y la tarea de cada hora los publica. El riesgo aceptado es más amplio que 15 minutos. |
| R3-D6 | 🟡 Major (churn) | "Descartar canal" y "quitar un canal" se contradicen, y `deletePost` no pasa por el punto de control. |
| R3-D7 | 🟡 Major | La suplantación de superadmin permite que una sola persona apruebe dos etapas con dos nombres distintos. |
| R3-D8 | 🟡 Major | La exclusión empieza en el último `SUBMITTED`: un Reviewer que editó antes del envío puede aprobar su propio texto. |
| R3-D9 | 🟡 Major | `updateMedia` también completa `alt` y `thumbnail`, quita archivos y depende de si el archivo sigue en la biblioteca. Eso cambia la huella sin que nadie edite. |
| R3-D10 | 🟡 Major | No se define qué pasa con los lotes que no tienen `PostApproval` después de un periodo con `APPROVALS_ENABLED=false`. |
| R3-S1 | 🟡 Major | "Decisiones tomadas" está dentro de "Open Questions". |
| R3-S2 | 🟡 Major | La tabla de riesgos cuelga del H3 del riesgo aceptado. |
| R3-S3 / T-M1 | 🟡 Major | Hay una línea rota en el diagrama. |
| R3-T2 a T8 | 🟡 Major | La razón de `shortLink`; "con seguridad" se presta a una lectura equivocada; la meta 1 está mal citada en la alternativa G; "punto de control", "bloqueo" y "regla de servicio" nombran lo mismo; las cifras de consultas a Temporal no coinciden; los motivos de las alternativas N y P son circulares; el uso de "post" y "lote". |

Los Nits (3 de diseño, 10 de estructura y 13 de estilo) están en los informes de
los revisores. No impiden que la ronda quede limpia.

---

# Ronda 4

| Revisor | Estado | Hallazgos |
|---|---|---|
| `egm-design` | completado | 1 Blocker, 7 Major y 8 Nit |
| `egm-structural` | completado | 3 Major y 12 Nit |
| `egm-style` | completado | 3 Major y 25 Nit |

**No está limpia.** El Elephant verificó el Blocker:

*   `docker-compose.yaml:214` publica `'7233:7233'`.
*   Con `postNow`, el workflow se salta la revisión de `QUEUE` y la espera
    (`post.workflow.v1.1.2.ts:161-173`).

## Hallazgos abiertos (Blocker y Major)

| # | Severidad | Tema |
|---|---|---|
| R4-D-B1 | 🔴 Blocker | El puerto gRPC 7233 de Temporal está publicado y no pide autenticación: cualquiera puede iniciar `postWorkflowV112` con `postNow` sobre un `DRAFT`. |
| R4-D-M1 / T-M1 | 🟡 Major | "Autor del lote" tiene tres definiciones. La meta 4 y la de `ApprovalPolicyService` no se actualizaron. |
| R4-D-M2 | 🟡 Major | Un lote de varios canales no se guarda de forma atómica: falta el orden de las escrituras y un `finally` para fallos a mitad del bucle. |
| R4-D-M3 | 🟡 Major | La huella usa `alt` y `thumbnail` de la fila de `Media`, que se editan en la biblioteca. `updateMedia` antepone `UPLOAD_DIRECTORY` a las rutas locales. |
| R4-D-M4 | 🟡 Major | El equipo puede quedarse sin aprobadores (un solo Monthly Reviewer, o un Reviewer que queda excluido por editar), y eso bloquea el flujo. |
| R4-D-M5 | 🟡 Major | El rechazo de la alternativa K se basa en una premisa falsa: el orquestador nunca escribe `QUEUE`. |
| R4-D-M6 | 🟡 Major | No se define qué hacer con un cuerpo que mezcla canales de varios lotes. |
| R4-D-M7 | 🟡 Major | Hay caminos que borran canales sin `deletePost` (reconexión, borrado de cuenta) o que ignoran su error con `.catch`. |
| R4-S-M1 | 🟡 Major | La "variante sin evaluar" de la alternativa I sigue sin decisión. |
| R4-S-M2 | 🟡 Major | A la tabla de transiciones le faltan pausar, reanudar y reintentar, y la redacción de "Desde" no es uniforme. |
| R4-S-M3 | 🟡 Major | Varias decisiones no tienen alternativa evaluada: `shortLink`, el brief rápido, la suplantación y los plugs. |
| R4-T-M2 | 🟡 Major | "Si había aprobaciones" no dice en qué etapas aplica. |
| R4-T-M3 | 🟡 Major | Una celda de riesgo residual se contradice. |

## Tendencia entre rondas

| Ronda | Blocker | Major nuevos | Fuente principal |
|---|---|---|---|
| 1 | 1 | 23 | Lógica del flujo y redacción |
| 2 | 0 | 21 | Caminos de Postiz (`updateMedia`, lote parcial) |
| 3 | 1 | ~20 | Caminos de Postiz (`changeDate('update')`, suplantación) y churn |
| 4 | 1 | 13 | Infraestructura (puerto 7233), atomicidad, caminos de borrado y restos de redacción |

Cada ronda baja la cantidad de Major, pero el revisor de diseño sigue
encontrando caminos reales de Postiz. Queda una ronda antes del límite (5).
