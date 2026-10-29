# Flujo de aprobación con 4 roles para un fork de Postiz

*   **Autor:** onix.ortiz.cruz@gmail.com
*   **Estado:** Propuesto
*   **Fecha:** 2026-10-28

Las rutas son relativas a la raíz del repo `postiz-app/`.

--------------------------------------------------------------------------------

## Overview

Un equipo interno va a usar Postiz como su plataforma de redes sociales. Postiz
es una herramienta de código abierto (AGPL-3.0) para programar posts y publicarlos.
El equipo la usará para crear posts, programarlos, publicarlos en Instagram,
Facebook y LinkedIn y revisar sus analíticas. La plataforma corre en un servidor
propio con Docker, a partir de un fork del repo.

El fork agrega dos cosas que Postiz no trae:

1.  **Cuatro roles de trabajo:** Technical Writer, Creator, Reviewer y Monthly
    Reviewer. Se asignan a personas y conviven con los roles que ya tiene
    Postiz (`SUPERADMIN`, `ADMIN`, `USER`).
2.  **Una cadena de aprobación que bloquea la publicación.** Ningún post llega a
    una red social sin la aprobación final del Monthly Reviewer, salga por donde
    salga: el editor, el calendario, la API pública, el SDK o el agente MCP.

## The Problem

Hoy, en Postiz, cualquier miembro de la organización puede programar un post, y
el post sale solo cuando llega su hora. No hay revisión ni aprobación, y no queda
registro de quién revisó qué.

Para este equipo eso es un problema por tres razones:

*   **Errores públicos.** Un post con un error de texto, una imagen equivocada o
    un tema que no se aprobó sale con el nombre de la marca. En la mayoría de las
    redes no se puede editar después de publicar, y borrarlo no evita que ya se
    haya visto.
*   **Las responsabilidades no se notan en la herramienta.** El equipo tiene
    cuatro funciones distintas: definir el tema, producir el post, revisarlo y
    aprobarlo. Postiz las trata a todas igual. No hay forma de saber en qué etapa
    está un post ni a quién le toca.
*   **Los permisos de Postiz no protegen nada en un servidor propio.** Si no está
    configurado Stripe, `PermissionsService.check` le da todos los permisos a
    cualquier usuario
    ([permissions.service.ts:50-63](apps/backend/src/services/auth/permissions/permissions.service.ts:50)).
    Aunque se configuraran roles, no frenarían a nadie.

Un intento simple, como esconder el botón "Schedule" o pedir que la gente avise
por chat, no funciona. Postiz tiene al menos seis caminos que ponen un post en
estado `QUEUE` (programado) y al menos cuatro mecanismos que lo publican sin pasar
por la pantalla:

*   la tarea que corre cada hora y republica posts en `QUEUE`;
*   los posts repetidos;
*   los "plugs";
*   el workflow, que revisa el estado solo antes de dormir hasta la hora de
    publicar.

**Solución propuesta.** Hacer de la aprobación final una condición para que un
post pueda estar en `QUEUE`, y aplicarla en un único punto de la capa de servicio.
Todo lo que no tenga esa aprobación se queda en `DRAFT`, y Postiz nunca publica un
`DRAFT`. El resto de la cadena (roles, etapas, historial, avisos y vencimiento)
vive en tablas nuevas del fork, separadas de las de Postiz.

## Goals

1.  **Ningún post se publica sin aprobación final.** Ningún camino (editor,
    calendario, API pública, SDK, MCP, tarea de cada hora, reintentos) pone en
    `QUEUE` un post cuya versión actual no tenga aprobación final del Monthly
    Reviewer. La única excepción es la publicación de emergencia (meta 8). Se
    verifica con una prueba por cada camino.
2.  **Cuatro roles asignables.** Un ADMIN asigna los roles Technical Writer,
    Creator, Reviewer y Monthly Reviewer a cualquier miembro de la organización.
    Un rol puede tener varias personas y una persona puede tener varios roles.
3.  **Cadena en orden.** Un post pasa por estas etapas: tema (Writer) →
    producción (Creator) → revisión (Reviewer) → aprobación final (Monthly
    Reviewer) → programado → publicado → verificado (Writer). Solo una persona
    con el rol correspondiente puede avanzar cada etapa.
4.  **Nadie se aprueba a sí mismo.** Una persona no puede aprobar un post que ella
    misma produjo, ni aprobar dos etapas seguidas del mismo post.
5.  **Cambiar el contenido reinicia la revisión.** Si alguien cambia el texto, la
    media, los canales o los ajustes de un post ya aprobado, el post vuelve a
    revisión y se cancela su programación. Mover solo la fecha a otra fecha
    futura no reinicia nada.
6.  **El rechazo tiene motivo.** Rechazar exige un comentario. El post vuelve al
    Creator con ese comentario visible.
7.  **Nada sale tarde sin permiso.** Si llega la hora programada y el post no
    tiene aprobación final, no se publica. El post queda vencido y se avisa por
    correo. También se avisa 48 h y 24 h antes de que venza.
8.  **Hay salida de emergencia, con registro.** El Monthly Reviewer puede forzar
    la publicación escribiendo un motivo. El motivo queda en el historial y se
    avisa al equipo.
9.  **Historial completo.** Cada acción del flujo queda registrada: quién, con
    qué rol, qué hizo, desde dónde y sobre qué versión del contenido. Ninguna
    acción borra ni edita una fila del historial.
10. **Cada persona sabe qué le toca.** Cada rol tiene una bandeja de "pendiente
    para mí". El Monthly Reviewer puede aprobar varios posts de una vez. El
    siguiente rol recibe un correo cuando le llega un post.
11. **Verificación después de publicar.** El sistema guarda el link del post
    publicado. El Technical Writer lo marca "verificado" o "tiene problema" en
    un plazo de 24 h. Un problema crea un borrador de corrección enlazado.
12. **El texto no aprobado no se filtra.** La página de preview exige que haya
    iniciado sesión un miembro de la organización.
13. **El fork sigue pudiendo actualizarse desde Postiz.** El código nuevo vive en
    carpetas propias. Cada archivo de Postiz que se toca aparece en una lista
    `FORK_TOUCHPOINTS`. No se cambian los enums `Role` ni `State` de Postiz.

## Non-Goals

*   **Analíticas propias o calificación interna de posts.** Se usan las
    analíticas que Postiz ya trae, y el Monthly Reviewer las revisa una vez al
    mes. Eso es un proceso del equipo, no una pantalla nueva.
*   **Redes distintas de Instagram, Facebook y LinkedIn en la primera versión.**
    El bloqueo no depende de la red y protege a todas, pero solo esas tres se
    configuran y se prueban.
*   **Posts repetidos (`intervalInDays`) y plugs.** Se desactivan en la primera
    versión porque publican contenido que nadie aprobó.
*   **Aprobar desde la API pública, el SDK o MCP.** Esos caminos solo crean y
    editan borradores, porque no identifican a una persona.
*   **Editar o borrar posts ya publicados en la red.** La mayoría de las redes no
    lo permiten. Un problema genera un borrador de corrección.
*   **Varias organizaciones o clientes externos.** Es un solo equipo interno.
*   **Uso comercial o reventa.** La licencia AGPL lo condiciona, y no se
    contempla.
*   **Migrar posts existentes.** Es una instalación nueva. Solo se incluye un
    script de seguridad que regresa a revisión cualquier post en `QUEUE` sin
    aprobación.

## Open Questions

*   **Normalización de la huella con links acortados.** Si `shortLink` está
    activo, volver a guardar un post sin cambios podría generar links distintos
    y reiniciar la aprobación sin motivo. Hay que comprobarlo con una prueba
    antes de implementar. Si pasa, la huella se calcula sobre el texto antes de
    acortar los links.

Las decisiones que estaban abiertas en el brief se resolvieron así (detalle en
el Technical Plan):

*   Red de seguridad al publicar: **solo la regla de servicio**, sin tocar el
    orquestador. Para achicar el hueco, la cancelación de workflows es estricta
    y una tarea de conciliación corre cada 15 minutos.
*   Esquema: **`prisma db push` + chequeo en CI** que impide que el fork quite o
    cambie algo de upstream.
*   Tema: **tabla nueva `ContentBrief`**.
*   Lote sin brief: al enviarlo a revisión, el editor le pide al Creator un tema
    de una línea y crea el brief a su nombre (`quickBrief = true`). Siempre queda
    un tema registrado, pero en esos casos no lo definió el Writer.
*   Post vencido y reprogramado: vuelve a la etapa en la que estaba antes de
    vencer. Si el contenido no cambió, conserva la aprobación del Reviewer.
*   Lote con un canal editado: **se reinicia el lote entero**, porque la unidad
    de aprobación es el lote.
*   Nombres en pantalla: ver la tabla de etapas.

## Critical User Journeys (CUJs)

### CUJ 1: Un post recorre la cadena completa

*   **Given**: Ana es Technical Writer, Beto es Creator, Carla es Reviewer y Dani
    es Monthly Reviewer. Hay un canal de Instagram y uno de LinkedIn conectados.
*   **When**: Ana escribe el tema y el texto base. Beto arma el post para los dos
    canales, con imagen y fecha del viernes a las 10:00, y lo envía a revisión.
    Carla lo aprueba. Dani lo aprueba desde su bandeja.
*   **Then**: El post pasa a `QUEUE` y se publica el viernes a las 10:00 en las
    dos redes. Ana recibe un correo para verificarlo, abre los links y lo marca
    verificado. El historial muestra las cinco acciones con nombre, rol y hora.

### CUJ 2: El Reviewer rechaza un post

*   **Given**: Un post está en revisión.
*   **When**: Carla lo rechaza con el comentario "La imagen no es la de la
    campaña".
*   **Then**: El post vuelve a Beto en la etapa "cambios pedidos", con el
    comentario visible. Beto recibe un correo. El post sigue en `DRAFT` y no
    puede publicarse. Cuando Beto lo reenvía, entra de nuevo a revisión.

### CUJ 3: Alguien edita un post ya aprobado

*   **Given**: Un post tiene aprobación final y está en `QUEUE` para mañana.
*   **When**: Beto corrige una palabra del texto desde el editor.
*   **Then**: El post vuelve a `DRAFT` y a la etapa de revisión, y se cancela su
    programación. Carla recibe un correo. Si en cambio Beto solo hubiera
    arrastrado el post a pasado mañana en el calendario, seguiría aprobado y en
    `QUEUE`, y el cambio de fecha quedaría en el historial.

### CUJ 4: Llega la hora sin aprobación

*   **Given**: Un post programado para hoy a las 15:00 sigue esperando la
    aprobación final.
*   **When**: Pasan las 15:00.
*   **Then**: El post no se publica. Queda en la etapa "vencido" y el equipo
    recibe un correo. Antes ya se habían enviado avisos 48 h y 24 h antes. Si
    Dani intenta aprobarlo, el sistema le pide una fecha nueva en el futuro.

### CUJ 5: Un camino automático intenta publicar

*   **Given**: Una integración externa usa la API pública con una API key.
*   **When**: Llama a `POST /public/v1/posts` con tipo `schedule`, o a
    `PUT /public/v1/posts/:id/status` para programar.
*   **Then**: El post se crea o se queda como borrador en la etapa de producción.
    La respuesta lo indica, y nada se publica hasta que el post recorre la
    cadena.

### CUJ 6: Publicación de emergencia

*   **Given**: Hay que publicar un aviso urgente y Carla no está disponible.
*   **When**: Dani elige "Forzar publicación" y escribe el motivo.
*   **Then**: El post pasa a `QUEUE` y se publica. El historial guarda la acción
    como "forzado", con el motivo, y el equipo recibe un correo.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Glosario

| Término | Significado en este documento |
|---|---|
| **Post raíz** | Fila de `Post` con `parentPostId = null`. Es el primer mensaje de un canal. |
| **Hilo** | Las filas hijas de un post raíz (comentarios o tuits siguientes). |
| **Canal** | Una integración conectada (`Integration`), por ejemplo la página de Facebook del equipo. |
| **Lote** | Todos los posts raíz que comparten `batchId`, es decir, el mismo contenido para varios canales. **Es la unidad de aprobación.** |
| **Brief** | El tema y el texto base que escribe el Technical Writer (`ContentBrief`). |
| **Huella** | Un hash SHA-256 del contenido de un canal: texto, media, retraso y ajustes del post raíz y su hilo. |
| **Estado** | El campo `Post.state` de Postiz (`DRAFT`, `QUEUE`, `PUBLISHED`, `ERROR`). No se cambia. |
| **Etapa** | El paso del flujo en que está un lote (`PostApproval.stage`). Es nuevo y vive en el fork. |

### La regla central

> Un post raíz solo puede estar en `QUEUE` si su lote está en la etapa
> `APPROVED` y la huella actual de cada canal coincide con la huella guardada al
> aprobar.

Todo lo demás se apoya en esto. Postiz nunca inicia un workflow para un post en
`DRAFT` ([posts.service.ts:965](libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:965)).
La tarea que corre cada hora solo mira posts en `QUEUE`
([posts.repository.ts:36-64](libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts:36)).
Por eso, mantener en `DRAFT` todo lo que no está aprobado basta para que no se
publique, sin tocar el orquestador.

La regla se aplica en un solo lugar: un servicio nuevo, `ApprovalGateService`.
Los cuatro métodos de `PostsService` que pueden producir `QUEUE` lo llaman antes
de escribir.

### Diagrama

```text
  Editor web   Calendario   API pública / SDK   Agente MCP
       │            │               │                 │
       └────────────┴───────┬───────┴─────────────────┘
                            ▼
   PostsService.createPost / changeDate / changePostStatus / updatePostSettings
                            │
                            ▼  (antes de escribir)
                 ┌───────────────────────┐
                 │  ApprovalGateService  │◄── PostApproval (etapa, huellas)
                 │  decide el estado:    │
                 │  QUEUE solo si        │
                 │  aprobado + huella ok │
                 └──────────┬────────────┘
                            ▼
        PostsRepository.createOrUpdatePost / changeDate / changeState
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
        state = DRAFT                state = QUEUE
     (sin workflow)          startWorkflow → postWorkflowV112 (sin cambios)
                                           │
                                           ▼
                                  la red publica → PUBLISHED / ERROR

  ApprovalsController (web, con sesión) ──► ApprovalService
       enviar / aprobar / rechazar / forzar / verificar
       │  valida el rol con ApprovalPolicyService
       │  escribe PostApprovalEvent en la misma transacción
       └► en la aprobación final: changePostStatus('schedule') por cada post raíz

  approvalSweepWorkflow (orquestador, nuevo, cada 15 min)
       ├─ vence los lotes no aprobados cuya hora pasó, y avisa
       ├─ avisa 48 h y 24 h antes de vencer
       ├─ marca PUBLISHED cuando todos los canales salieron, y pide verificación
       ├─ avisa si la verificación lleva más de 24 h pendiente
       └─ concilia: un post en QUEUE sin aprobación pasa a DRAFT y se cancela su
          workflow; un post en DRAFT con un workflow corriendo, se cancela
```

### Modelo de datos (tablas nuevas)

Las cuatro tablas van en un bloque marcado `// ==== FORK: approvals ====` al
final de [schema.prisma](libraries/nestjs-libraries/src/database/prisma/schema.prisma).
Sus relaciones apuntan desde el fork hacia las tablas de Postiz y nunca al
revés: en los modelos de Postiz solo se agregan los campos de relación inversa
que Prisma exige. No cambia ningún enum de Postiz.

**`WorkflowRoleAssignment`**: quién tiene qué rol de trabajo.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | |
| `organizationId` | → Organization | |
| `userId` | → User | |
| `role` | enum `WorkflowRole` (`TECHNICAL_WRITER`, `CREATOR`, `REVIEWER`, `MONTHLY_REVIEWER`) | Enum nuevo del fork. |
| `createdById` | → User | El ADMIN que asignó el rol. |
| `createdAt`, `deletedAt` | | Quitar un rol es un borrado lógico. |

Índice único en (`organizationId`, `userId`, `role`) para las filas no borradas.
Una persona puede tener varias filas, una por rol.

**`ContentBrief`**: el tema del Technical Writer.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `organizationId` | | |
| `topic` | texto corto | Obligatorio. |
| `baseCopy` | texto | Texto base sugerido. |
| `targetDate` | fecha, opcional | Fecha objetivo de publicación. |
| `assignedCreatorId` | → User, opcional | |
| `status` | enum `BriefStatus` (`OPEN`, `IN_PRODUCTION`, `DONE`, `CANCELLED`) | |
| `correctionOfApprovalId` | → PostApproval, opcional | Se llena cuando el brief nace de una verificación con problema. |
| `quickBrief` | booleano | `true` si lo creó el Creator al enviar a revisión, en lugar del Writer. La pantalla de briefs lo marca. |
| `createdById`, `createdAt`, `updatedAt`, `deletedAt` | | |

**`PostApproval`**: una fila por lote.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `organizationId` | | |
| `batchId` | texto, único | Igual al `Post.batchId` del lote. |
| `briefId` | → ContentBrief, opcional | |
| `stage` | enum `ApprovalStage` | Ver la tabla de etapas. |
| `stageBeforeExpiry` | `ApprovalStage`, opcional | Etapa a la que vuelve un lote vencido cuando se reprograma. |
| `approvedFingerprints` | JSON `{ [integrationId]: sha256 }` | Se llena en la aprobación final y se borra al reiniciar. |
| `reviewerApprovedFingerprints` | JSON | Se guarda cuando aprueba el Reviewer. Sirve para conservar esa aprobación al reprogramar un lote vencido. |
| `earliestPublishDate` | fecha | La fecha más temprana entre los posts raíz del lote. Se recalcula en cada guardado y la usa la tarea de vencimiento. |
| `forced` | booleano | `true` si el Monthly Reviewer forzó la publicación. |
| `warned48At`, `warned24At`, `verifyDueAt` | fechas, opcionales | Controlan los avisos. |
| `verifiedAt`, `verifiedById` | opcionales | |
| `createdAt`, `updatedAt` | | |

**`PostApprovalEvent`**: el historial. Solo se insertan filas.

| Campo | Notas |
|---|---|
| `id`, `organizationId`, `approvalId` | |
| `actorUserId` | Vacío para acciones del sistema y de la API con API key. |
| `actorRole` | El `WorkflowRole` con el que actuó, o `SYSTEM`. |
| `action` | enum `ApprovalAction`: `CREATED`, `LINKED_BRIEF`, `SUBMITTED`, `REVIEW_APPROVED`, `FINAL_APPROVED`, `REJECTED`, `RESET_BY_EDIT`, `DATE_CHANGED`, `EXPIRED`, `RESCHEDULED`, `FORCED`, `PUBLISHED`, `VERIFIED`, `VERIFICATION_PROBLEM`, `BLOCKED`, `RECONCILED`. |
| `surface` | El `CreationMethod` de Postiz (`WEB`, `API`, `MCP`, …). |
| `fingerprints` | JSON con las huellas en ese momento. |
| `snapshot` | JSON con el texto y la media de cada canal en ese momento. |
| `commentId` | → Comments, opcional. Obligatorio en `REJECTED` y `VERIFICATION_PROBLEM`. |
| `reason` | texto, opcional. Obligatorio en `FORCED`. |
| `createdAt` | |

### Etapas y transiciones

| Etapa (`stage`) | Nombre en pantalla | `Post.state` permitido |
|---|---|---|
| `IN_PRODUCTION` | En producción | `DRAFT` |
| `IN_REVIEW` | En revisión | `DRAFT` |
| `AWAITING_FINAL` | Esperando aprobación final | `DRAFT` |
| `CHANGES_REQUESTED` | Cambios pedidos | `DRAFT` |
| `APPROVED` | Aprobado | `QUEUE`, `DRAFT` (en pausa) o `ERROR` (reintento pendiente) |
| `EXPIRED` | Vencido | `DRAFT` |
| `PUBLISHED` | Publicado – falta verificar | `PUBLISHED` |
| `VERIFIED` | Verificado | `PUBLISHED` |
| `VERIFICATION_PROBLEM` | Publicado con problema | `PUBLISHED` |

| Desde | Acción | Quién | Hacia | Condición |
|---|---|---|---|---|
| (nada) | Primer guardado de un lote | Cualquiera | `IN_PRODUCTION` | Se crea `PostApproval` y el post queda en `DRAFT` aunque se haya pedido `schedule`. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED` | Enviar a revisión | Creator | `IN_REVIEW` | Todos los canales pasan la validación de Postiz (`validatePosts`). Si el lote no tiene brief, la petición trae un `quickTopic` de una línea y se crea un `ContentBrief` con `quickBrief = true` a nombre del Creator. Sin brief y sin `quickTopic`, se rechaza. |
| `IN_REVIEW` | Aprobar | Reviewer | `AWAITING_FINAL` | El actor no es quien envió el lote. Se guarda `reviewerApprovedFingerprints`. |
| `IN_REVIEW`, `AWAITING_FINAL` | Rechazar | Reviewer o Monthly Reviewer | `CHANGES_REQUESTED` | Comentario obligatorio. |
| `AWAITING_FINAL` | Aprobación final | Monthly Reviewer | `APPROVED` | El actor no aprobó la etapa anterior ni envió el lote. Todas las fechas están en el futuro. Se guardan las huellas y cada post raíz pasa a `QUEUE`. |
| Cualquiera antes de `APPROVED` | Forzar publicación | Monthly Reviewer | `APPROVED` | Motivo obligatorio. `forced = true`. Se avisa a todos. |
| `IN_REVIEW`, `AWAITING_FINAL`, `APPROVED` | Cambio de contenido (la huella cambia) | Cualquiera, desde cualquier superficie | `IN_REVIEW` | Se borran las huellas aprobadas, todo el lote pasa a `DRAFT` y se cancelan sus workflows. |
| `APPROVED` | Solo cambio de fecha a una fecha futura | Cualquiera | `APPROVED` | Se registra `DATE_CHANGED`. Una fecha pasada se rechaza. |
| Antes de `APPROVED` | Pasa `earliestPublishDate` | Sistema | `EXPIRED` | Se guarda `stageBeforeExpiry` y se avisa. |
| `EXPIRED` | Cambio de fecha a una fecha futura | Cualquiera | `stageBeforeExpiry` | Si la huella cambió, la regla de "cambio de contenido" tiene prioridad. |
| `APPROVED` | Todos los posts raíz en `PUBLISHED` | Sistema | `PUBLISHED` | `verifyDueAt = ahora + 24 h`. Se avisa al Writer. |
| `PUBLISHED` | Verificar | Technical Writer | `VERIFIED` | |
| `PUBLISHED` | Marcar problema | Technical Writer | `VERIFICATION_PROBLEM` | Comentario obligatorio. Se crea un `ContentBrief` con `correctionOfApprovalId`. |

**Un canal con error.** Si un canal de un lote aprobado termina en `ERROR`, el
lote se queda en `APPROVED`. Cualquiera puede reintentar reprogramándolo
(`changeDate` o `changePostStatus('schedule')`). Pasa sin aprobación nueva
mientras la huella no cambie. La pantalla muestra el estado de cada canal.

### Huella del contenido

*   Hay una huella por canal (`integrationId`) dentro del lote.
*   **Entra en la huella:** para el post raíz y cada hijo, en orden, el
    `content`, la lista de media (`id` y `path` de cada imagen o video), el
    `delay`, y los `settings` del canal con las claves ordenadas.
*   **No entra:** `publishDate`, `state`, `releaseId`, `releaseURL`, `error`,
    etiquetas, `group` ni ids de fila. Ninguno de esos campos cambia lo que se
    publica, o los reescribe el sistema.
*   Una sola función pura, `computeChannelFingerprint(channel)`, recibe una
    estructura normalizada. Dos adaptadores la alimentan: uno arma la estructura
    desde el cuerpo de `createPost` (después de acortar links y quitar links),
    el otro desde las filas de la base. Una prueba comprueba que ambos producen
    lo mismo para el mismo post.
*   **Agregar o quitar un canal** del lote cuenta como cambio de contenido.

### Cómo cada camino pasa por el punto de control

| Camino | Método de `PostsService` | Qué hace el punto de control |
|---|---|---|
| Editor web: Guardar / Agregar al calendario / Programar | `createPost` (tipos `draft`, `schedule`) | Si no se cumple la regla, cambia el tipo a `draft`. Si el lote estaba aprobado y la huella cambió, reinicia a `IN_REVIEW`. |
| Editor web: Post Now | `createPost` (tipo `now`) | Igual. Publicar ya solo es posible si el lote ya está aprobado y sin cambios. |
| Edición que mantiene el estado | `createPost` (tipo `update`) | Si la huella cambió en un lote aprobado, cambia el tipo a `draft` y reinicia. Si no cambió, lo deja pasar. |
| Ajustes por API o MCP | `updatePostSettings` → `createPost('update')` | Lo cubre la fila anterior. Los ajustes forman parte de la huella. |
| Calendario: arrastrar | `changeDate` | Rechaza las fechas pasadas. En un lote aprobado lo deja pasar y registra `DATE_CHANGED`. En un lote vencido lo devuelve a `stageBeforeExpiry`. Si el post está en `DRAFT`, Postiz ya lo mantiene en `DRAFT` ([posts.repository.ts:557-582](libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts:557)). |
| API pública: crear post | `createPost` vía [public.integrations.controller.ts:230](apps/backend/src/public-api/routes/v1/public.integrations.controller.ts:230) | Igual que el editor. La respuesta agrega `approvalStage` para que el cliente vea que quedó como borrador. |
| API pública: cambiar estado | `changePostStatus` ([public.integrations.controller.ts:643](apps/backend/src/public-api/routes/v1/public.integrations.controller.ts:643)) | `schedule` sobre un lote no aprobado responde `400` con el mensaje "Este post necesita aprobación final". `draft` siempre se permite. |
| SDK | Usa la API pública | Igual que la API pública. |
| Agente MCP: programar | `createPost` vía [integration.schedule.post.ts:256](libraries/nestjs-libraries/src/chat/tools/integration.schedule.post.ts:256) | Igual que el editor. |
| Autopost, clipping, generador | `createPost` con tipo `draft` | Sin cambio de comportamiento. Se crea el `PostApproval` en `IN_PRODUCTION`. |
| Posts repetidos | `body.inter` en `createPost` | El punto de control fuerza `inter = undefined`, de modo que `intervalInDays` siempre queda vacío. |
| Plugs internos y globales | `checkInternalPlug` y `checkPlugs` ([posts.service.ts:822-895](libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:822)), que llama el orquestador | Con el fork activo, ambos devuelven `[]`. No cambia el workflow ni los parámetros de las actividades. Los endpoints para crear o activar plugs responden `400`. |
| Tarea que corre cada hora | Lee `QUEUE` | No hace falta nada: por la regla, solo encuentra posts aprobados. |
| Aprobación final | `ApprovalService.approveFinal` → `changePostStatus('schedule')` por cada post raíz | Pasa porque el lote ya está aprobado. |

**Cancelación estricta de workflows.** `startWorkflow` de Postiz se traga los
errores. El punto de control no lo usa para cancelar. Llama a un método propio,
`terminatePostWorkflows(postId)`, que usa la misma consulta (`postId="…" AND
ExecutionStatus="Running"`) pero **lanza el error** si no puede cancelar. Cuando
la cancelación falla, el guardado se rechaza con un `503` ("No se pudo detener la
programación; intenta de nuevo") y no se escribe nada. El post queda como estaba:
aprobado y con su versión aprobada.

**El hueco que queda (decisión A).** Puede pasar que un post salga de `QUEUE` por
un camino que no conocemos (por ejemplo, uno nuevo que agregue upstream) y que su
workflow siga dormido. En ese caso publica al despertar. La tarea de conciliación
lo detecta en hasta 15 minutos. Si la hora de publicar llega antes, el post se
publica. Lo vigilan la métrica `approval_reconciled` y la lista
`FORK_TOUCHPOINTS`, que se revisa en cada actualización desde upstream.

### Roles y permisos

*   `ApprovalPolicyService.assertCan(actor, orgId, action, approval)` valida cada
    acción del flujo. Lee `WorkflowRoleAssignment` y el historial para aplicar
    las reglas "nadie se aprueba a sí mismo" y "nadie aprueba dos etapas
    seguidas". No usa `@CheckPolicies`, que no protege nada sin Stripe.
*   Asignar y quitar roles de trabajo exige `UserOrganization.role` igual a
    `ADMIN` o `SUPERADMIN`. Se lee directo de la base.
*   Las acciones del flujo (enviar, aprobar, rechazar, forzar, verificar) **solo**
    se aceptan desde `ApprovalsController`, que está detrás de la sesión web
    normal (`GetUserFromRequest`). La API pública, el SDK y MCP no tienen esos
    endpoints. Solo crean y editan posts, que quedan como borradores.
*   Ver y editar posts sigue igual que en Postiz: todos los miembros ven y editan
    todo.

### Avisos

*   Cuando un lote cambia de etapa, se envía un correo a cada persona con el rol
    que sigue, con `NotificationService.sendEmail(to, …)`
    ([notification.service.ts:110](libraries/nestjs-libraries/src/database/prisma/notifications/notification.service.ts:110)).
    También se crea un aviso interno con `inAppNotification`, con `link` al post.
*   **A quién le llega:** en `IN_REVIEW`, a los Reviewer; en `AWAITING_FINAL`, a
    los Monthly Reviewer; en `CHANGES_REQUESTED`, a quien envió el lote; en
    `PUBLISHED`, a los Technical Writer. `EXPIRED`, `FORCED` y
    `VERIFICATION_PROBLEM` le llegan a todas las personas con algún rol de
    trabajo.
*   Sin `EMAIL_PROVIDER` configurado, solo funcionan los avisos internos. El
    servidor muestra una advertencia en el log al arrancar.

### Tarea de mantenimiento (`approvalSweepWorkflow`)

*   Es un workflow nuevo del orquestador que copia el patrón de
    [missing.post.workflow.ts](apps/orchestrator/src/workflows/missing.post.workflow.ts):
    hace un paso, duerme 15 minutos y reinicia con `continueAsNew`. Se registra
    junto a `missingPostWorkflow` en
    [infinite.workflow.register.ts](libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts).
*   Llama a una sola actividad nueva, `approvalSweep()`, en un archivo de
    actividad nuevo. Esa actividad delega en `ApprovalSweepService` del backend
    compartido. No cambia ningún workflow ni actividad existente.
*   Cada paso hace cinco cosas, todas idempotentes:
    1.  Vence los lotes cuya etapa es anterior a `APPROVED` y cuya
        `earliestPublishDate` ya pasó.
    2.  Manda los avisos de 48 h y 24 h, y marca `warned48At` y `warned24At`.
    3.  Pasa a `PUBLISHED` los lotes `APPROVED` cuyos posts raíz están todos en
        `PUBLISHED`.
    4.  Avisa de nuevo cuando pasa `verifyDueAt` sin verificación.
    5.  Concilia los estados:
        *   un post raíz en `QUEUE` cuyo lote no cumple la regla pasa a `DRAFT`,
            se cancela su workflow y se registra `RECONCILED`;
        *   un post raíz en `DRAFT` con un workflow corriendo, se cancela.

### Página de preview

*   Con el fork activo, los tres endpoints públicos `/public/posts/:id`
    ([public.controller.ts:54-88](apps/backend/src/api/routes/public.controller.ts:54))
    responden `404`.
*   La página `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx`
    pasa a leer desde un endpoint nuevo con sesión, `GET /approvals/preview/:id`,
    que solo devuelve posts de la organización del usuario.
*   Los comentarios se crean con el endpoint con sesión que ya existe en
    [posts.controller.ts:85-93](apps/backend/src/api/routes/posts.controller.ts:85).
    En el fork, ese endpoint comprueba además que el post pertenezca a la
    organización.

### Pantallas nuevas y cambios visibles

*   **Bandeja "Pendiente para mí"** (ruta nueva `/approvals`): los lotes de las
    etapas que le tocan a cada rol del usuario. El Monthly Reviewer puede
    seleccionar varios y aprobarlos de una vez. El servidor procesa cada uno por
    separado y devuelve cuáles pasaron y cuáles no, con el motivo.
*   **Briefs** (ruta nueva `/briefs`): el Writer crea y edita briefs. El Creator
    pulsa "Crear post desde este brief", que abre el editor con el texto base; al
    guardar, el lote queda enlazado al brief.
*   **Panel de aprobación en el editor** (componente nuevo montado en
    [manage.modal.tsx](apps/frontend/src/components/new-launch/manage.modal.tsx)):
    muestra la etapa, los botones que el usuario puede usar según su rol y el
    historial del lote.
*   **Botones del editor:** con el fork activo, "Add to calendar", "Schedule" y
    "Post Now" pasan a decir "Guardar". El botón "Enviar a revisión" vive en el
    panel de aprobación.
*   **Calendario:** cada post muestra una insignia con su etapa. El filtro existente
    ([filters.tsx](apps/frontend/src/components/launches/filters.tsx)) agrega
    "Etapa".
*   **Equipo:** en la configuración del equipo
    ([teams.component.tsx](apps/frontend/src/components/settings/teams.component.tsx)),
    un ADMIN marca los roles de trabajo de cada miembro.
*   **Menú superior** ([top.menu.tsx](apps/frontend/src/components/layout/top.menu.tsx)):
    agrega "Aprobaciones" y "Briefs" para todos los miembros.

### Interruptor del fork

*   Una variable de entorno, `APPROVALS_ENABLED`, activa todo el comportamiento
    del fork. En el `docker-compose` del fork vale `true`.
*   Con `false`, `ApprovalGateService` deja pasar todo y los plugs vuelven a
    funcionar. Las tablas se conservan.
*   Sirve para volver atrás en una emergencia y para comparar el comportamiento
    con el de upstream en pruebas. No sirve para apagar el flujo en el día a
    día.

### Esquema y actualizaciones desde upstream

*   Se sigue usando `prisma db push` al arrancar, como upstream.
*   Un script nuevo, `scripts/fork/check-schema-additive.mjs`, se ejecuta en CI.
    Hace tres cosas:
    1.  Toma el `schema.prisma` de `upstream/main`.
    2.  Genera con `prisma migrate diff` el SQL necesario para pasar del esquema
        de upstream al del fork. El SQL solo se analiza, nunca se ejecuta.
    3.  Falla si ese SQL contiene `DROP`, `ALTER COLUMN` o `RENAME` sobre una
        tabla de upstream, o si cambia un enum de upstream.
*   `FORK_TOUCHPOINTS.md` (en la raíz) lista cada archivo de upstream que el
    fork modifica, con la función tocada y el motivo. En cada actualización
    desde upstream se revisa archivo por archivo.

### Despliegue

*   El fork construye su propia imagen a partir de `Dockerfile.dev` y la publica
    en el registro del equipo. `docker-compose.yaml` del fork apunta a esa
    imagen y no a `ghcr.io/gitroomhq/postiz-app:latest`.
*   Se corrige `var/docker/docker-build.sh`, que hoy apunta a etapas que no
    existen.
*   Los volúmenes de Postgres, Redis, Temporal y Elasticsearch pasan a ser
    volúmenes con nombre, para que recrear los contenedores no borre los
    workflows programados.
*   **Variables obligatorias:** `APPROVALS_ENABLED=true`, `RUN_CRON=true` en el
    orquestador, `EMAIL_PROVIDER` y sus credenciales, y las credenciales de las
    apps de Meta (Facebook e Instagram) y de LinkedIn.
*   `STRIPE_*` se deja vacío.
*   El puerto 8080 de la interfaz de Temporal no se expone a internet.

### Observabilidad

*   **Métricas** con `Sentry.metrics.count`, igual que el `post_created` que ya
    existe:
    *   `approval_blocked`: el punto de control cambió un `schedule` o `now` a
        `draft`;
    *   `approval_reset`;
    *   `approval_expired`;
    *   `approval_forced`;
    *   `approval_reconciled`;
    *   `approval_terminate_failed`.
*   **Alerta:** cualquier valor de `approval_reconciled` mayor que cero indica un
    camino que esquiva la regla y hay que investigarlo.
*   **Logs:** cada acción del flujo escribe una línea con `approvalId`,
    `batchId`, la acción y el actor.

### Instalación inicial

El brief pedía un script que, en el primer arranque, regrese a revisión los posts
en `QUEUE` sin aprobación. No hace falta un script aparte: el primer paso de
`approvalSweepWorkflow`, que corre al arrancar el orquestador, ya concilia
esos posts (punto 5 de la tarea de mantenimiento).

--------------------------------------------------------------------------------

## Alternatives Considered

### Enfoque general

#### Alternativa A: servicio aparte, sin fork

Postiz queda sin cambios. Un servicio pequeño al lado guarda las aprobaciones,
mantiene todo en `DRAFT` y, en la aprobación final, llama a
`PUT /public/v1/posts/:id/status` con una API key.

*   **A favor**: actualizar desde upstream no cuesta nada. El código propio queda
    totalmente separado.
*   **En contra**: cualquier miembro puede programar directo desde el editor o el
    calendario de Postiz y saltarse el flujo. Para impedirlo habría que cambiar
    las rutas de programación de Postiz, que es justo lo que el servicio
    pretendía evitar. Además, la API key entra como `SUPERADMIN` sin usuario, así
    que el servicio tendría que llevar su propio sistema de usuarios.
*   **Motivo del rechazo**: no cumple la meta 1 (ningún post se publica sin
    aprobación final).

#### Alternativa B: Notion, Trello o una hoja de cálculo junto a Postiz sin cambios

El equipo lleva el flujo en una herramienta externa y solo programa en Postiz lo
que se aprobó ahí.

*   **A favor**: no hay que escribir código y se puede empezar hoy.
*   **En contra**: nada impide programar sin aprobación. El historial y la
    herramienta de publicación están separados. No hay vencimiento automático.
*   **Motivo del rechazo**: depende solo de la disciplina del equipo. Sirve como
    prueba de proceso mientras se construye el fork, no como solución.

### Roles y estados

#### Alternativa C: agregar los 4 roles al enum `Role` de Postiz

*   **A favor**: un solo lugar para los roles, sin tabla nueva.
*   **En contra**:
    *   `Role` es una escalera de privilegios que se compara con niveles
        numéricos (`organization.service.ts:193-196`, `teams.component.tsx:121-124`).
    *   Las invitaciones solo aceptan `USER` o `ADMIN`.
    *   El menú superior filtra por rol, así que un rol nuevo perdería opciones.
    *   `UserOrganization.role` guarda un solo valor, así que nadie podría ser
        `ADMIN` y Monthly Reviewer a la vez.
*   **Motivo del rechazo**: rompe partes de Postiz que no tienen nada que ver con
    la aprobación, y contradice la meta 2 (una persona con varios roles).

#### Alternativa D: agregar etapas de aprobación al enum `State`

*   **A favor**: la etapa se vería directo en cada post, sin tabla aparte.
*   **En contra**:
    *   Unas 35 comparaciones en 17 archivos listan los estados a mano, y los
        posts con estados nuevos desaparecerían de listas, de la API y de MCP.
    *   `startWorkflow` solo se salta `DRAFT`, así que cualquier estado nuevo
        iniciaría un workflow que lo marcaría como `ERROR 'Already posted'`.
    *   Es muy probable que upstream agregue estados propios más adelante y
        choque con los nuestros.
*   **Motivo del rechazo**: es demasiado costoso y frágil. `State` queda solo
    para la publicación, y la etapa vive en `PostApproval`.

#### Alternativa E: columnas de aprobación en la tabla `Post`

*   **A favor**: no hay que hacer joins.
*   **En contra**: `Post` es el modelo que upstream cambia con más frecuencia. La
    fila se reescribe en cada guardado y el panel rota el `group`. Tampoco queda
    historial.
*   **Motivo del rechazo**: aumenta los conflictos con upstream y no sirve para
    la meta 9 (historial completo).

#### Alternativa F: reutilizar `approvedSubmitForOrder` o `Customer`

*   **A favor**: los campos ya existen.
*   **En contra**: `approvedSubmitForOrder` es un resto del marketplace sin uso,
    y `Customer` solo agrupa canales para agencias. Ninguno representa etapas ni
    roles.
*   **Motivo del rechazo**: no sirven para el flujo, y darles un significado
    nuevo confundiría a quien lea el código de upstream. Solo se copia la idea
    de que la marca se reinicia en cada guardado (`posts.repository.ts:680`).

### Dónde se aplica el bloqueo

#### Alternativa G: bloquear solo en la pantalla o en los controladores

*   **A favor**: es el cambio más chico.
*   **En contra**: la API pública, el SDK, MCP, la tarea de cada hora, los posts
    repetidos y las ediciones tipo `update` no pasan por esos botones ni por
    esos controladores.
*   **Motivo del rechazo**: no cumple la meta 1.

#### Alternativa H: confiar en `@CheckPolicies` (CASL)

*   **A favor**: es el mecanismo de permisos que Postiz ya trae.
*   **En contra**: sin Stripe configurado, `PermissionsService.check` concede
    todo (`permissions.service.ts:50-63`).
*   **Motivo del rechazo**: en un servidor propio no bloquea nada.

#### Alternativa I: comprobar la aprobación dentro de la actividad `postSocial`

Antes de llamar a la red, la actividad comprueba la aprobación y la huella, y
lanza `BadBody` si no coinciden.

*   **A favor**: cierra el hueco de los workflows que siguen dormidos, con un
    cambio chico en un solo archivo y sin cambiar parámetros.
*   **En contra**: el post bloqueado termina en `ERROR` con un mensaje genérico,
    y Postiz manda su aviso normal de error. Habría que repetir la comprobación
    en `postComment` para los hilos. Además, es un archivo más del orquestador
    que vigilar en cada actualización.
*   **Motivo del rechazo**: la persona dueña del diseño eligió no tocar el
    orquestador. El hueco se acepta y se achica con la cancelación estricta y la
    conciliación cada 15 minutos. Es la primera opción a reconsiderar si
    `approval_reconciled` registra casos reales.

#### Alternativa J: un workflow nuevo (V113) que vuelva a comprobar al despertar

*   **A favor**: es el manejo más limpio. El post bloqueado queda "vencido" o
    "bloqueado" en vez de `ERROR`.
*   **En contra**: son unas 700 líneas copiadas de V112. La siguiente versión de
    upstream choca con el nombre, y cada arreglo que upstream haga en V112 hay
    que portarlo a mano. El nombre del workflow aparece escrito en dos lugares
    (`posts.service.ts:972` y `post.activity.ts:121`).
*   **Motivo del rechazo**: es el costo de mantenimiento más alto de todas las
    opciones, para cerrar un hueco que la conciliación ya vigila.

#### Alternativa K: un middleware de Prisma que bloquee las escrituras de `QUEUE`

*   **A favor**: atraparía cualquier camino, incluso los nuevos de upstream.
*   **En contra**: quien lee el repositorio no ve que existe. El orquestador
    comparte el mismo cliente de Prisma y también lo sufriría. Además, el
    middleware no sabe quién actúa ni desde dónde.
*   **Motivo del rechazo**: su comportamiento sorprende y es difícil de depurar.
    La conciliación cumple la función de red de seguridad de forma visible.

#### Alternativa L: llevar la aprobación en señales de Temporal

*   **A favor**: el workflow sabría directamente si está aprobado.
*   **En contra**: Postiz cancela y reinicia el workflow en cada guardado, y las
    señales se pierden con él.
*   **Motivo del rechazo**: la base de datos tiene que ser la fuente de verdad.

### Unidad de aprobación y reinicio

#### Alternativa M: usar `group` como llave de la aprobación

*   **A favor**: es el campo que usa el calendario.
*   **En contra**: el panel le asigna un `group` nuevo en cada guardado, y
    `group` cubre un solo canal.
*   **Motivo del rechazo**: la llave cambiaría todo el tiempo. Se usa `batchId`,
    que el repositorio mantiene igual entre guardados (`posts.repository.ts:626-649`).

#### Alternativa N: aprobación por canal

*   **A favor**: un error en un canal no frena a los demás.
*   **En contra**: multiplica los clics del Monthly Reviewer, que tendría que
    aprobar lo mismo una vez por red, y crea estados parciales confusos.
*   **Motivo del rechazo**: se decidió aprobar por lote. Como consecuencia,
    editar un solo canal reinicia el lote entero.

#### Alternativa O: aprobar el calendario del mes en un solo paso

*   **A favor**: el jefe interviene una sola vez al mes.
*   **En contra**: los posts nuevos y los cambios a mitad de mes no pasarían por
    el jefe.
*   **Motivo del rechazo**: no cumple la meta 1. La bandeja con aprobación de
    varios posts a la vez resuelve la carga de trabajo.

#### Alternativa P: reiniciar todo desde el principio con cualquier cambio

*   **A favor**: es la regla más estricta y la más simple de explicar.
*   **En contra**: corregir una letra o arrastrar un post en el calendario
    borraría todas las aprobaciones.
*   **Motivo del rechazo**: un cambio de contenido vuelve a revisión, pero
    cambiar solo la fecha no reinicia nada.

#### Alternativa Q: usar `updatedAt` en lugar de una huella

*   **A favor**: el campo ya existe.
*   **En contra**: cambia con cualquier actualización, incluidos los cambios de
    estado, de media y de `releaseURL` que hace el sistema.
*   **Motivo del rechazo**: reiniciaría aprobaciones sin que nadie haya cambiado
    el contenido.

### Otros caminos, redes y datos

#### Alternativa R: apagar del todo la API pública, el SDK y MCP

*   **A favor**: es lo más seguro y lo más simple.
*   **En contra**: se pierde la automatización externa, como crear borradores
    desde otras herramientas.
*   **Motivo del rechazo**: basta con que esos caminos solo puedan crear
    borradores.

#### Alternativa S: mantener las 36 redes activas

*   **A favor**: no se cierra ninguna puerta.
*   **En contra**: cada red necesita su propia app de desarrollador, sus
    credenciales y, a veces, la revisión de la plataforma. Además, 24 de las 36
    no tienen analíticas.
*   **Motivo del rechazo**: el equipo usa tres. El bloqueo protege a todas igual;
    solo se configuran y se prueban Instagram, Facebook y LinkedIn.

#### Alternativa T: pasar el fork a `prisma migrate`

*   **A favor**: deja historial de cambios, SQL revisable y una vuelta atrás
    ordenada.
*   **En contra**: en cada actualización desde upstream hay que generar una
    migración para sus cambios de esquema, y cambian los scripts de arranque.
*   **Motivo del rechazo**: se eligió `db push` con un chequeo en CI que impide
    tocar lo de upstream. La vuelta atrás de las tablas del fork se hace a mano
    y queda documentada.

#### Alternativa U: guardar el tema en `PostApproval` o como etiqueta

*   **A favor**: no hace falta tabla ni pantalla nueva.
*   **En contra**: el Writer tendría que elegir canal y fecha antes de tiempo, y
    un tema no podría generar varios posts. Con etiquetas, además, el tema no
    tiene estructura y no hay lista de temas pendientes.
*   **Motivo del rechazo**: el tema existe antes que el post, así que va en su
    propia tabla, `ContentBrief`.

#### Alternativa V: dejar pública la página de preview

*   **A favor**: se puede compartir con gente de fuera.
*   **En contra**: quien tenga el ID de un post puede leer texto no aprobado, y
    comentar con solo un nombre.
*   **Motivo del rechazo**: no cumple la meta 12.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Seguridad**
    *   Las acciones del flujo solo se aceptan con una sesión web y se validan en
        la capa de servicio.
    *   El preview exige sesión.
    *   El historial no se edita ni se borra desde la aplicación.
    *   `STRIPE_*` queda vacío y la UI de Temporal no se expone a internet.
    *   La licencia AGPL-3.0 obliga a ofrecer el código fuente a quien use la
        plataforma por la red. Para un equipo interno basta con que el repo del
        fork esté disponible para sus usuarios.
*   **Rendimiento**
    *   El punto de control agrega a cada guardado una lectura de `PostApproval`
        y de las filas del lote, más un hash SHA-256 por canal.
    *   La tarea de mantenimiento hace 5 consultas indexadas cada 15 minutos.
    *   Para un equipo de 4 a 10 personas ninguna de las dos cosas es medible.
*   **Despliegue y vuelta atrás**
    *   `APPROVALS_ENABLED=false` devuelve a Postiz su comportamiento de origen
        sin borrar datos.
    *   Para quitar las tablas del fork se siguen los pasos manuales del
        runbook.

### Future Improvements

*   **Red de seguridad en el orquestador.** Si `approval_reconciled` registra
    casos reales, agregar la comprobación en `postSocial` (alternativa I).
*   **Más redes.** El bloqueo ya las cubre. Solo falta configurar credenciales y
    probar cada una.
*   **Aprobar desde la API con OAuth.** Hoy solo se aprueba desde la web. Un
    token OAuth sí identifica a la persona (`oauthUserId`), así que se podría
    permitir aprobar con ese tipo de token.
*   **Informe mensual de analíticas** para el Monthly Reviewer, construido sobre
    las analíticas que Postiz ya trae.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Reglas que siguen todos los archivos, tomadas de [CLAUDE.md](CLAUDE.md):

*   **Capas del backend:** DTO → Controller → Service → Repository, sin atajos.
*   **Base de datos:** solo Prisma, nunca SQL a mano.
*   **Frontend:** un hook de SWR por recurso, con `useFetch`; componentes propios
    con Tailwind 3 y sin colores `--color-custom*`.
*   **Orquestador:** no se modifica ningún workflow ni actividad existente.

Cada archivo de upstream que se modifica entra en `FORK_TOUCHPOINTS.md`. Esos
archivos están marcados como **(upstream)**.

### Target Files to Create/Modify

#### A. Esquema

##### 1. `libraries/nestjs-libraries/src/database/prisma/schema.prisma` (Modify, upstream)

*   **Tipo / alcance**: esquema de Prisma.
*   **Cambios propuestos**:
    *   Al final del archivo, un bloque entre `// ==== FORK: approvals ====` y
        `// ==== END FORK ====`. Contiene:
        *   los enums `WorkflowRole`, `ApprovalStage`, `ApprovalAction` y
            `BriefStatus`;
        *   los modelos `WorkflowRoleAssignment`, `ContentBrief`,
            `PostApproval` y `PostApprovalEvent`, con los campos del Technical
            Plan.
    *   Índices: `PostApproval(batchId)` único, `PostApproval(organizationId,
        stage)`, `PostApproval(earliestPublishDate)`,
        `PostApprovalEvent(approvalId, createdAt)`,
        `WorkflowRoleAssignment(organizationId, role)` y `ContentBrief(organizationId,
        status)`.
    *   En `Organization`, `User` y `Comments` solo se agregan los campos de
        relación inversa que Prisma exige, cada uno con el comentario `// FORK`.
    *   `PostApproval.batchId` no tiene clave foránea hacia `Post`, porque
        `Post.batchId` no es único.
*   **Por qué**: guarda el flujo sin tocar ningún campo ni enum de upstream.

#### B. Backend compartido (librería)

##### 2. `libraries/nestjs-libraries/src/database/prisma/approvals/approvals.repository.ts` (Create)

*   **Tipo / alcance**: repositorio de NestJS con `PrismaRepository`, siguiendo
    el patrón de `posts.repository.ts`.
*   **Cambios propuestos**: un método por consulta.
    *   **Aprobaciones:**
        *   `getApprovalByBatch(orgId, batchId)`;
        *   `createApproval(orgId, batchId, stage, earliestPublishDate)`;
        *   `updateApproval(id, data)`, que hace una actualización condicional
            sobre `stage`, `WHERE id AND stage = expectedStage`, para evitar
            carreras entre dos aprobadores;
        *   `insertEvent(event)`.
    *   **Lote:**
        *   `getBatchRootPosts(orgId, batchId)`, que devuelve las filas no
            borradas con hilo, `integrationId`, `state` y `publishDate`;
        *   `findBatchIdFor(orgId, group, ids)`, que repite el criterio de
            `createOrUpdatePost` (`posts.repository.ts:626-649`) sin tocar ese
            archivo.
    *   **Bandeja y calendario:**
        *   `listInbox(orgId, stages[])`, que cruza con posts no borrados para
            ocultar lotes eliminados;
        *   `getStagesForPosts(orgId, postIds[])`, que devuelve
            `{ postId: { batchId, stage } }`.
    *   **Roles:** `getRoles(orgId, userId)`, `listUsersWithRole(orgId, role)`
        (devuelve `id` y `email`) y `setRoles(orgId, userId, roles[], byUserId)`.
    *   **Briefs:** `createBrief`, `updateBrief`, `listBriefs(orgId, status?)` y
        `getBrief`.
    *   **Para la tarea de mantenimiento:**
        *   `findExpirable(now)`, `findWarnable(now, hours)`,
            `findPublishedCandidates()` y `findVerificationOverdue(now)`;
        *   `findQueueRootsWithoutApproval()`, que trae los posts raíz en
            `QUEUE` cuyo lote no está en `APPROVED`;
        *   `findDraftRoots(ids)`;
        *   `setRootPostsDraft(orgId, postIds[])`, que pone `state = DRAFT` en
            los posts raíz y sus hilos. Lo usan el punto de control y la tarea
            de mantenimiento.
    *   **Aislamiento entre organizaciones:** todas las consultas filtran por
        `organizationId`. Los métodos que leen `User` usan `select` con solo
        `id` y `email`.
*   **Por qué**: es el único punto de acceso a las tablas del fork.

##### 3. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.policy.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS.
*   **Cambios propuestos**:
    *   `assertCan(actorUserId, orgId, action, approval)`. Lanza
        `ForbiddenException` con un mensaje claro si falla alguna de estas
        reglas:
        1.  El actor tiene el `WorkflowRole` que exige la acción, según la tabla
            de transiciones.
        2.  En `REVIEW_APPROVED`, el actor no es quien hizo el último
            `SUBMITTED`.
        3.  En `FINAL_APPROVED`, el actor no es quien hizo el último `SUBMITTED`
            ni el último `REVIEW_APPROVED`.
        4.  En `FORCED`, el actor tiene el rol `MONTHLY_REVIEWER`.
    *   `assertIsOrgAdmin(userId, orgId)`. Lee `UserOrganization.role` y acepta
        `ADMIN` o `SUPERADMIN`.
*   **Por qué**: `@CheckPolicies` no protege nada sin Stripe, así que los roles
    se validan de forma explícita.

##### 4. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository` y
    de `TemporalService`. No depende de `PostsService`, para evitar una
    dependencia circular.
*   **Cambios propuestos**:
    *   `enabled()`: devuelve `process.env.APPROVALS_ENABLED === 'true'`.
    *   `computeChannelFingerprint(normalized)`, junto con
        `normalizeFromBody(post)` y `normalizeFromRows(rows)`. Son métodos
        privados, no un archivo de algoritmos aparte.
        *   La estructura normalizada es
            `{ integrationId, items: [{ content, media: [{id, path}], delay }], settings }`.
        *   `settings` lleva las claves ordenadas.
        *   El resultado es `sha256(JSON.stringify(estructura))`.
    *   `beforeCreatePost(orgId, body, post, actor)`. Se llama dentro del bucle
        de `createPost` (archivo 9), después de convertir los links y antes de
        `createOrUpdatePost`. Devuelve `{ type, inter, resetBatch, approval }`
        según estos pasos:
        1.  Si `!enabled()`, devuelve el tipo y el `inter` originales.
        2.  Siempre devuelve `inter = undefined`, para que no haya posts
            repetidos.
        3.  Busca el `batchId` con `findBatchIdFor`. Si no hay lote o
            aprobación, devuelve `type = 'draft'` cuando el tipo pedido era
            `schedule` o `now`. `afterCreatePost` crea luego la aprobación.
        4.  Calcula la huella del canal con `normalizeFromBody` y la compara con
            la guardada:
            *   en `approvedFingerprints` si la etapa es `APPROVED`;
            *   en `reviewerApprovedFingerprints` si es `AWAITING_FINAL`;
            *   en las huellas del último `SUBMITTED` si es `IN_REVIEW`.
        5.  Si la huella cambió y la etapa es `IN_REVIEW`, `AWAITING_FINAL` o
            `APPROVED`:
            *   devuelve `resetBatch = true` y `type = 'draft'` (también cuando
                el tipo pedido era `update`);
            *   antes de devolver, ejecuta `terminatePostWorkflows` sobre todos
                los posts raíz del lote. Si esto falla, lanza el error y el
                guardado se cancela.
        6.  Si la huella no cambió y la etapa es `APPROVED`, deja pasar el tipo
            pedido.
        7.  En cualquier otro caso, cambia `schedule` y `now` por `draft`.
    *   `afterCreatePost(orgId, batchId, savedRootIds, decision, actor, surface)`:
        *   crea el `PostApproval` en `IN_PRODUCTION` si no existía, con un
            evento `CREATED`;
        *   si `resetBatch`:
            *   pasa a `DRAFT` los demás posts raíz del lote, con
                `ApprovalsRepository.setRootPostsDraft`;
            *   cambia la etapa a `IN_REVIEW` y borra `approvedFingerprints`;
            *   registra `RESET_BY_EDIT` y avisa a los Reviewer;
        *   recalcula `earliestPublishDate`;
        *   si cambió un `schedule` o `now` por `draft`, registra `BLOCKED` y
            suma la métrica `approval_blocked`.
    *   `beforeChangeDate(orgId, postId, date, actor)`:
        *   rechaza las fechas pasadas con `BadRequestException`;
        *   si la etapa es `APPROVED`, registra `DATE_CHANGED`;
        *   si es `EXPIRED`, restaura `stageBeforeExpiry` y registra
            `RESCHEDULED`;
        *   en todos los casos recalcula `earliestPublishDate`.
    *   `beforeChangePostStatus(orgId, postId, status)`:
        *   si `status === 'schedule'` y el lote no cumple la regla central,
            lanza `BadRequestException('Este post necesita aprobación final')`;
        *   `draft` siempre pasa.
    *   `plugsEnabled()`: devuelve `!enabled()`.
    *   `terminatePostWorkflows(postId)`:
        *   usa la misma consulta de Temporal que `startWorkflow`
            (`posts.service.ts:944-963`), pero sin `try/catch` vacío;
        *   si falla, suma la métrica `approval_terminate_failed` y lanza
            `ServiceUnavailableException`.
*   **Por qué**: es el único lugar donde se aplica la regla central.

##### 5. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository`,
    `ApprovalPolicyService`, `ApprovalGateService`, `PostsService` y
    `NotificationService`.
*   **Cambios propuestos**: cada acción hace lo mismo:
    1.  Carga la aprobación.
    2.  Llama a `assertCan`.
    3.  Valida la etapa de origen.
    4.  Actualiza con la condición sobre la etapa.
    5.  Inserta el evento en la misma transacción de Prisma
        (`$transaction`).
    6.  Envía los avisos fuera de la transacción.

    Las acciones son:
    *   `submit(orgId, batchId, actor, quickTopic?)`:
        *   ejecuta `PostsService.validatePosts` sobre los canales del lote; si
            alguno no pasa, devuelve el error;
        *   si no hay brief y llega `quickTopic`, crea un `ContentBrief` con
            `quickBrief = true` a nombre del actor y lo enlaza;
        *   guarda las huellas en el evento `SUBMITTED`;
        *   pasa a `IN_REVIEW` y avisa a los Reviewer.
    *   `reviewApprove(orgId, batchId, actor)`:
        *   comprueba que la huella actual coincide con la del último
            `SUBMITTED`;
        *   guarda `reviewerApprovedFingerprints`;
        *   pasa a `AWAITING_FINAL` y avisa a los Monthly Reviewer.
    *   `reject(orgId, batchId, actor, commentText)`:
        *   crea el comentario sobre el primer post raíz del lote con el mismo
            método que el endpoint de comentarios con sesión;
        *   copia el texto también en `event.reason`, para que el historial
            sobreviva si esa fila se borra;
        *   pasa a `CHANGES_REQUESTED` y avisa a quien hizo el último
            `SUBMITTED`.
    *   `finalApprove(orgId, batchIds[], actor)`: procesa cada lote por
        separado y devuelve `[{ batchId, ok, error? }]`. Para cada lote:
        1.  Calcula la huella de cada canal desde la base y la compara con
            `reviewerApprovedFingerprints`.
        2.  Exige que todas las `publishDate` estén en el futuro.
        3.  Guarda `approvedFingerprints` y pasa a `APPROVED`.
        4.  Ejecuta `PostsService.changePostStatus(orgId, rootId, 'schedule')`
            por cada post raíz. Esa llamada inicia el workflow
            `postWorkflowV112` sin cambios.
    *   `force(orgId, batchId, actor, reason)`:
        *   la etapa de origen puede ser cualquiera anterior a `APPROVED`;
        *   exige fechas futuras;
        *   guarda las huellas actuales con `forced = true` y pasa a `APPROVED`;
        *   registra `FORCED` con el motivo, programa igual que
            `finalApprove`, avisa a todos y suma `approval_forced`.
    *   `verify(orgId, batchId, actor)`: pasa de `PUBLISHED` a `VERIFIED`.
    *   `markProblem(orgId, batchId, actor, commentText)`:
        *   crea un `ContentBrief` con `correctionOfApprovalId` y como tema
            "Corrección: " seguido del tema original;
        *   pasa a `VERIFICATION_PROBLEM`.
    *   `linkBrief(orgId, batchId, briefId, actor)`: enlaza el brief, lo pasa a
        `IN_PRODUCTION` y registra `LINKED_BRIEF`.
    *   **Lecturas:**
        *   `getInbox(orgId, actor)`, que trae las etapas según los roles del
            actor;
        *   `getBatch(orgId, batchId)`, que trae la aprobación, el historial y el
            estado de cada canal;
        *   `getStages(orgId, postIds[])`;
        *   `getPreview(orgId, postId)`, que devuelve lo mismo que
            `PublicController.getPreview`, pero solo para la organización;
        *   `getRoles(orgId)`;
        *   `setRoles(orgId, userId, roles[], actor)`, que llama a
            `assertIsOrgAdmin`.
    *   **Avisos:** un método privado `notifyRole(orgId, role, subject, html,
        link)` hace dos cosas:
        *   llama a `NotificationService.sendEmail` por cada persona con ese
            rol;
        *   crea un único `inAppNotification` con `link`.
*   **Por qué**: aquí vive la lógica de cada paso del flujo.

##### 6. `libraries/nestjs-libraries/src/database/prisma/approvals/briefs.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS.
*   **Cambios propuestos**:
    *   `list(orgId, status?)`, `create(orgId, actor, dto)`,
        `update(orgId, id, actor, dto)` y `cancel(orgId, id, actor)`.
    *   Crear y editar exige el rol `TECHNICAL_WRITER`. Los briefs con
        `quickBrief = true` también los puede editar quien los creó.
    *   El estado pasa a `DONE` cuando su lote llega a `PUBLISHED`. Lo hace la
        tarea de mantenimiento.
*   **Por qué**: gestiona el tema antes de que exista un post.

##### 7. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.sweep.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS.
*   **Cambios propuestos**: un método `run(now)` que ejecuta en orden los cinco
    pasos de la tarea de mantenimiento del Technical Plan. Cada paso está en
    su propio `try/catch`, registra el error y sigue con el siguiente.
    *   **Paso 1, vencer:** cambia `stage` a `EXPIRED`, guarda
        `stageBeforeExpiry` y registra `EXPIRED`.
    *   **Paso 2, avisar antes:** manda los avisos a 48 h y 24 h, y marca
        `warned48At` y `warned24At`.
    *   **Paso 3, publicado:** pasa a `PUBLISHED`, registra `PUBLISHED`, fija
        `verifyDueAt = now + 24h` y marca el brief como `DONE`.
    *   **Paso 4, verificación vencida:** avisa a los Technical Writer y a los
        Monthly Reviewer, una sola vez (`verifyDueAt` se mueve a `null` después
        de avisar).
    *   **Paso 5, conciliar:**
        *   un post en `QUEUE` sin aprobación válida pasa a `DRAFT` con
            `setRootPostsDraft`; se cancelan sus workflows, se registra `RECONCILED`
            y se suma `approval_reconciled`;
        *   un post raíz en `DRAFT` con un workflow corriendo se cancela.
    *   Los pasos solo cambian algo cuando la etapa actual sigue cumpliendo la
        condición, así que se pueden repetir sin efectos dobles.
*   **Por qué**: aquí se hace lo que nadie dispara a mano (vencimientos, avisos,
    publicaciones confirmadas) y se vigila el hueco aceptado en la decisión A.

##### 8. `libraries/nestjs-libraries/src/database/prisma/database.module.ts` (Modify, upstream)

*   **Cambios propuestos**: se agregan a `providers` estos servicios:
    `ApprovalsRepository`, `ApprovalPolicyService`, `ApprovalGateService`,
    `ApprovalService`, `BriefsService` y `ApprovalSweepService`.
*   **Por qué**: los inyecta tanto el backend como el orquestador.

##### 9. `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` (Modify, upstream)

*   **Cambios propuestos** (cada uno marcado con `// FORK: approvals`):
    1.  **Constructor:** inyecta `ApprovalGateService`.
    2.  **`createPost`:** recibe un quinto parámetro opcional,
        `actorUserId?: string`. Sus llamadores actuales no cambian.
        *   Dentro del bucle, después de calcular `post.value` y antes de
            `createOrUpdatePost`, llama a `beforeCreatePost`. Luego usa
            `decision.type` y `decision.inter` en lugar de `body.type` y
            `body.inter`.
        *   Después de guardar, llama a `afterCreatePost`.
        *   La condición `if (body.type !== 'update')` que inicia el workflow
            pasa a usar `decision.type`.
        *   Cada elemento de la respuesta agrega `approvalStage`. Antes de
            hacerlo se buscan todos los consumidores de la respuesta (frontend,
            API pública, herramientas MCP y `updatePostSettings`) y se confirma
            que un campo extra no los rompe.
    3.  **`changeDate`:** recibe `actorUserId?: string` opcional y llama a
        `beforeChangeDate` antes de `this._postRepository.changeDate`.
    4.  **`changePostStatus`:** llama a `beforeChangePostStatus` antes de
        `changeState`.
    5.  **`checkInternalPlug` y `checkPlugs`:** al inicio, `if
        (!this._approvalGate.plugsEnabled()) return [];`.
*   **Por qué**: son los únicos cuatro lugares por donde un post puede llegar a
    `QUEUE`, más las dos fuentes de plugs que el orquestador consulta. El
    cambio se limita a llamadas cortas a un servicio del fork, para que las
    actualizaciones desde upstream tengan pocos conflictos.

##### 10. `libraries/nestjs-libraries/src/dtos/approvals/approval.actions.dto.ts` (Create)

*   **Tipo / alcance**: DTOs de `class-validator`.
*   **Cambios propuestos**:
    *   `SubmitApprovalDto { quickTopic?: string (máx. 140) }`.
    *   `RejectApprovalDto { comment: string (obligatorio, mín. 3) }`.
    *   `FinalApproveDto { batchIds: string[] (1 a 50) }`.
    *   `ForceApprovalDto { reason: string (obligatorio, mín. 10) }`.
    *   `ProblemApprovalDto { comment: string (obligatorio) }`.
    *   `LinkBriefDto { briefId: string }`.
    *   `StagesQueryDto { postIds: string[] (máx. 500) }`.
    *   `SetWorkflowRolesDto { roles: WorkflowRole[] }`.

##### 11. `libraries/nestjs-libraries/src/dtos/approvals/brief.dto.ts` (Create)

*   **Cambios propuestos**:
    *   `CreateBriefDto { topic (obligatorio, máx. 200), baseCopy?,
        targetDate?, assignedCreatorId? }`.
    *   `UpdateBriefDto`, igual pero con todos los campos opcionales.

##### 12. `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts` (Modify, upstream)

*   **Cambios propuestos**: dentro del mismo `if (!!process.env.RUN_CRON)`,
    se agrega un segundo `workflow.start('approvalSweepWorkflow', { workflowId:
    'approval-sweep-workflow', taskQueue: 'main' })` con su propio `try/catch`.
*   **Por qué**: arranca la tarea de mantenimiento igual que
    `missingPostWorkflow`.

#### C. Backend (API)

##### 13. `apps/backend/src/api/routes/approvals.controller.ts` (Create)

*   **Tipo / alcance**: controlador de NestJS que usa `GetOrgFromRequest` y
    `GetUserFromRequest`.
*   **Cambios propuestos**: todas las rutas delegan en `ApprovalService`.
    *   `GET /approvals/inbox`
    *   `GET /approvals/batch/:batchId`
    *   `POST /approvals/stages` (body `StagesQueryDto`)
    *   `POST /approvals/batch/:batchId/submit`
    *   `POST /approvals/batch/:batchId/review-approve`
    *   `POST /approvals/batch/:batchId/reject`
    *   `POST /approvals/final-approve`
    *   `POST /approvals/batch/:batchId/force`
    *   `POST /approvals/batch/:batchId/verify`
    *   `POST /approvals/batch/:batchId/problem`
    *   `POST /approvals/batch/:batchId/link-brief`
    *   `GET /approvals/preview/:postId`
    *   `GET /approvals/roles`
    *   `PUT /approvals/roles/:userId`
*   **Por qué**: es la única entrada a las acciones del flujo. Solo se puede
    usar con sesión web, nunca con API key ni desde MCP.

##### 14. `apps/backend/src/api/routes/briefs.controller.ts` (Create)

*   **Cambios propuestos**: `GET /briefs?status=`, `POST /briefs`,
    `PUT /briefs/:id` y `DELETE /briefs/:id` (cancelar). Todas delegan en
    `BriefsService`.

##### 15. `apps/backend/src/api/api.module.ts` (Modify, upstream)

*   **Cambios propuestos**: se agregan `ApprovalsController` y
    `BriefsController` a `authenticatedController`.

##### 16. `apps/backend/src/api/routes/posts.controller.ts` (Modify, upstream)

*   **Cambios propuestos**:
    *   `createPost` (`POST /posts`) recibe `@GetUserFromRequest() user` y pasa
        `user.id` como `actorUserId`.
    *   `changeDate` (`PUT /posts/:id/date`) hace lo mismo.
    *   En el endpoint de comentarios (líneas 85-93), se comprueba que el post
        pertenezca a la organización antes de crear el comentario.
*   **Por qué**: el historial necesita saber quién editó. Además, cierra el
    comentario cruzado entre organizaciones.

##### 17. `apps/backend/src/api/routes/public.controller.ts` (Modify, upstream)

*   **Cambios propuestos**: con `APPROVALS_ENABLED=true`, `GET /public/posts/:id`,
    `GET /public/posts/:id/comments` y `POST /public/posts/:id/comments`
    responden `NotFoundException`.
*   **Por qué**: cumple la meta 12.

##### 18. `apps/backend/src/api/routes/integrations.controller.ts` (Modify, upstream)

*   **Cambios propuestos**: con el fork activo, `POST /:id/plugs` y
    `PUT /plugs/:id/activate` responden `BadRequestException('Los plugs están
    desactivados en esta instalación')`. Las rutas de lectura no cambian.
*   **Por qué**: impide configurar plugs que, de todas formas, no se ejecutarían.

#### D. Orquestador

##### 19. `apps/orchestrator/src/workflows/approval.sweep.workflow.ts` (Create)

*   **Tipo / alcance**: workflow de Temporal.
*   **Cambios propuestos**: `approvalSweepWorkflow()` hace tres cosas:
    1.  Llama a la actividad `approvalSweep()` con `startToCloseTimeout` de
        5 minutos y 3 reintentos.
    2.  Duerme 15 minutos con `sleep`.
    3.  Llama a `continueAsNew()`.

    Copia la forma de `missing.post.workflow.ts`.

##### 20. `apps/orchestrator/src/workflows/index.ts` (Modify, upstream)

*   **Cambios propuestos**: agrega
    `export * from './approval.sweep.workflow';`.

##### 21. `apps/orchestrator/src/activities/approval.activity.ts` (Create)

*   **Tipo / alcance**: clase de actividades con `@Activity` y
    `@ActivityMethod`, igual que `post.activity.ts`.
*   **Cambios propuestos**: `approvalSweep()` llama a
    `ApprovalSweepService.run(new Date())`.

##### 22. `apps/orchestrator/src/app.module.ts` (Modify, upstream)

*   **Cambios propuestos**: agrega `ApprovalActivity` a la lista de
    actividades.

#### E. Frontend

##### 23. `libraries/react-shared-libraries/src/helpers/variable.context.tsx` (Modify, upstream)

*   **Cambios propuestos**: agrega `approvalsEnabled: boolean` al contexto, con
    `false` por defecto.

##### 24. `apps/frontend/src/app/(app)/layout.tsx` (Modify, upstream)

*   **Cambios propuestos**: pasa `approvalsEnabled={process.env.APPROVALS_ENABLED === 'true'}`
    a `VariableContextComponent`.

##### 25. `apps/frontend/src/components/approvals/use.approvals.ts` (Create)

*   **Tipo / alcance**: hooks de SWR, uno por recurso, cumpliendo
    `react-hooks/rules-of-hooks` y usando `useFetch`.
*   **Cambios propuestos**:
    *   lecturas: `useApprovalInbox()`, `useApprovalBatch(batchId)`,
        `useApprovalStages(postIds)` (es un POST, con clave SWR derivada de los
        ids ordenados), `useWorkflowRoles()` y `useBriefs(status)`;
    *   acciones: funciones simples con `useFetch` (no son hooks de SWR) que
        devuelven la respuesta y llaman a `mutate`.

##### 26. `apps/frontend/src/components/approvals/approval.stage.badge.tsx` (Create)

*   **Cambios propuestos**: muestra la etiqueta de la etapa con su nombre en
    pantalla y un color tomado de `colors.scss`. Se usa en el calendario, la
    bandeja y el panel.

##### 27. `apps/frontend/src/components/approvals/approval.panel.component.tsx` (Create)

*   **Cambios propuestos**: un panel lateral del editor con tres partes:
    *   **Etapa actual.**
    *   **Botones según los roles del usuario y la etapa:**
        *   Enviar a revisión;
        *   Aprobar;
        *   Rechazar, que pide comentario;
        *   Aprobación final;
        *   Forzar publicación, que pide motivo;
        *   Verificar o Marcar problema.
    *   **Historial:** el componente del archivo 28.

    Comportamiento:
    *   **Enviar sin brief:** abre `quick.brief.modal.tsx`.
    *   **Errores:** se muestran con el sistema de avisos (toasts) que ya usa el
        editor.

##### 28. `apps/frontend/src/components/approvals/approval.history.component.tsx` (Create)

*   **Cambios propuestos**: la línea de tiempo de `PostApprovalEvent`. Cada
    evento muestra la acción, la persona, el rol, la superficie, la hora local
    y el comentario o el motivo, si los tiene.

##### 29. `apps/frontend/src/components/approvals/quick.brief.modal.tsx` (Create)

*   **Cambios propuestos**: un modal con un solo campo, "Tema (una línea)", que
    envía `submit` con `quickTopic`.

##### 30. `apps/frontend/src/components/approvals/approvals.inbox.component.tsx` (Create)

*   **Cambios propuestos**: muestra los lotes agrupados por etapa, cada uno con
    su brief, sus canales, su fecha y su insignia. Abrir un lote lleva al
    editor.
    *   El Monthly Reviewer tiene casillas y un botón "Aprobar seleccionados".
        Ese botón llama a `final-approve` y muestra el resultado de cada lote.

##### 31. `apps/frontend/src/app/(app)/(site)/approvals/page.tsx` (Create)

*   **Cambios propuestos**: la ruta `/approvals`, que monta el componente del
    archivo 30. Sigue el patrón de `launches/page.tsx`.

##### 32. `apps/frontend/src/components/briefs/briefs.component.tsx` (Create)

*   **Cambios propuestos**:
    *   una lista de briefs con filtro por estado, que marca los
        `quickBrief = true` con "Tema rápido";
    *   un formulario para crear y editar, solo visible para el Technical
        Writer;
    *   el botón "Crear post desde este brief", que abre el editor con
        `baseCopy` como texto inicial y guarda el `briefId` en el store del
        editor.

##### 33. `apps/frontend/src/app/(app)/(site)/briefs/page.tsx` (Create)

*   **Cambios propuestos**: la ruta `/briefs`, que monta el componente del
    archivo 32.

##### 34. `apps/frontend/src/components/new-launch/manage.modal.tsx` (Modify, upstream)

*   **Cambios propuestos** (solo con `approvalsEnabled`):
    *   monta `ApprovalPanel`;
    *   las etiquetas "Add to calendar", "Schedule", "Post Now" y "Schedule all
        channels" pasan a mostrar "Guardar";
    *   al guardar, si el store tiene `briefId` y el lote aún no tiene brief,
        llama a `link-brief` con el `batchId`, que se obtiene de
        `POST /approvals/stages` con los `postId` devueltos.
*   **Por qué**: el editor tiene que mostrar el flujo y no prometer una
    publicación que no va a ocurrir.

##### 35. `apps/frontend/src/components/new-launch/store.ts` (Modify, upstream)

*   **Cambios propuestos**: agrega `briefId?: string` y su setter.

##### 36. `apps/frontend/src/components/launches/calendar.tsx` (Modify, upstream)

*   **Cambios propuestos**:
    *   llama a `useApprovalStages` con los ids de la semana o el mes visible y
        dibuja `ApprovalStageBadge` en cada post;
    *   un post en `QUEUE` con fecha pasada ya no se dibuja como publicado
        cuando su etapa no es `PUBLISHED` ni `VERIFIED`. Esto corrige el caso de
        las líneas 843-844.

##### 37. `apps/frontend/src/components/launches/filters.tsx` (Modify, upstream)

*   **Cambios propuestos**: agrega un selector "Etapa" que filtra en el cliente
    los posts del calendario usando el resultado de `useApprovalStages`.

##### 38. `apps/frontend/src/components/layout/top.menu.tsx` (Modify, upstream)

*   **Cambios propuestos**: con `approvalsEnabled`, agrega las entradas
    "Aprobaciones" (`/approvals`) y "Briefs" (`/briefs`), visibles para todos
    los roles de Postiz.

##### 39. `apps/frontend/src/components/settings/workflow.roles.component.tsx` (Create)

*   **Cambios propuestos**: muestra una fila por miembro con cuatro casillas,
    una por rol de trabajo. Solo un ADMIN puede editarlas, y cada cambio llama a
    `PUT /approvals/roles/:userId`.

##### 40. `apps/frontend/src/components/settings/teams.component.tsx` (Modify, upstream)

*   **Cambios propuestos**: con `approvalsEnabled`, monta
    `WorkflowRolesComponent` debajo de la lista de miembros.

##### 41. `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx` (Modify, upstream)

*   **Cambios propuestos**:
    *   con `approvalsEnabled`, lee desde `GET /approvals/preview/:id`;
    *   si no hay sesión, redirige a `/auth/login`;
    *   los comentarios usan el endpoint con sesión `POST /posts/:id/comments`.

##### 42. `libraries/react-shared-libraries/src/translation/locales/en/translation.json` y `.../es/translation.json` (Modify, upstream)

*   **Cambios propuestos**: agregan las claves de las pantallas nuevas, con el
    prefijo `approvals_`. Las demás lenguas usan el texto en inglés por
    defecto.

#### F. Infraestructura, documentación y CI

##### 43. `docker-compose.yaml` (Modify, upstream)

*   **Cambios propuestos**:
    *   `image` apunta a la imagen del fork (`${FORK_IMAGE}`);
    *   agrega volúmenes con nombre para Postgres, Redis, Temporal y
        Elasticsearch;
    *   agrega `APPROVALS_ENABLED=true` y `RUN_CRON=true`;
    *   elimina la publicación del puerto 8080 de la UI de Temporal.

##### 44. `var/docker/docker-build.sh` (Modify, upstream)

*   **Cambios propuestos**: construye una sola imagen desde `Dockerfile.dev`,
    con la etiqueta `${FORK_IMAGE}`, y la publica.

##### 45. `.env.example` (Modify, upstream)

*   **Cambios propuestos**: documenta `APPROVALS_ENABLED`, `FORK_IMAGE`,
    `EMAIL_PROVIDER` y sus variables, y las credenciales de Facebook,
    Instagram y LinkedIn que se necesitan. Indica que `STRIPE_*` debe quedar
    vacío.

##### 46. `scripts/fork/check-schema-additive.mjs` (Create)

*   **Tipo / alcance**: script de Node para CI.
*   **Cambios propuestos**: recibe la ruta del `schema.prisma` de upstream y la
    del fork, y hace lo siguiente:
    1.  Ejecuta `pnpm dlx prisma@6.5.0 migrate diff --from-schema-datamodel
        <upstream> --to-schema-datamodel <fork> --script`.
    2.  Analiza el SQL resultante sin ejecutarlo.
    3.  Sale con código 1 si encuentra `DROP`, `ALTER COLUMN`, `RENAME` o
        `ALTER TYPE` sobre tablas o enums que existen en upstream.

##### 47. `.github/workflows/fork-checks.yml` (Create)

*   **Cambios propuestos**: se ejecuta en cada PR y hace cuatro pasos:
    1.  Hace checkout y ejecuta `git fetch` del remoto `upstream`.
    2.  Ejecuta `check-schema-additive.mjs` contra
        `upstream/main:libraries/nestjs-libraries/src/database/prisma/schema.prisma`.
    3.  Ejecuta `pnpm lint` desde la raíz.
    4.  Ejecuta `pnpm test:fork`.

    Los workflows de upstream (`deploy-aws.yml`, `build-containers.yml` y
    `publish-extension.yml`) no se editan. Se desactivan desde la
    configuración de GitHub Actions del repo del fork.

##### 48. `jest.fork.config.ts` (Create)

*   **Cambios propuestos**: configuración de `ts-jest` (ya está en
    `package.json`). Tiene `moduleNameMapper` generado desde
    `tsconfig.base.json`, `testMatch` sobre `**/approvals/**/*.spec.ts` y
    `**/*.approvals.spec.ts`, y entorno `node`.
*   **Por qué**: el `jest.config.ts` de la raíz depende de `@nx/jest`, que no
    está en `package.json`. Una configuración propia evita tocarlo.

##### 49. `package.json` (Modify, upstream)

*   **Cambios propuestos**: agrega el script
    `"test:fork": "jest -c jest.fork.config.ts"`.

##### 50. `FORK_TOUCHPOINTS.md` (Create)

*   **Cambios propuestos**: una tabla con cada archivo marcado "(upstream)" en
    esta lista: el archivo, la función o zona tocada, el motivo, y qué revisar
    cuando upstream lo cambie. Incluye el procedimiento de actualización:
    1.  `git fetch upstream`.
    2.  `git merge upstream/main`.
    3.  Revisar cada archivo de la tabla.
    4.  Comprobar que siguen existiendo los cuatro métodos de
        `posts.service.ts` y las dos fuentes de plugs.
    5.  Buscar con `grep` escrituras nuevas de `state: 'QUEUE'` o
        `'QUEUE' as const`.
    6.  Ejecutar `pnpm test:fork`.

##### 51. `docs/fork/runbook.md` (Create)

*   **Cambios propuestos**:
    *   instalación en el VPS: variables, la app de Meta, la app de LinkedIn,
        el correo y la creación de los 4 usuarios con sus roles;
    *   operación: métricas, qué hacer si `approval_reconciled > 0` y cómo leer
        el historial;
    *   vuelta atrás: `APPROVALS_ENABLED=false`; y, para quitar las tablas,
        borrar el bloque `FORK` de `schema.prisma` y ejecutar `db push` con
        `--accept-data-loss` después de respaldar la base;
    *   la obligación de la licencia AGPL.

#### G. Pruebas

##### 52. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   **Huella:**
        *   `normalizeFromBody` y `normalizeFromRows` producen el mismo hash
            para el mismo post;
        *   cambiar el texto, la media, el retraso o los ajustes cambia el hash;
        *   cambiar `publishDate`, `releaseURL` o las etiquetas no lo cambia;
        *   volver a guardar con `shortLink` activo no cambia el hash. Si esta
            prueba falla, la huella se calcula sobre el texto antes de acortar
            los links.
    *   **`beforeCreatePost`:** una prueba por cada combinación de tipo
        (`draft`, `schedule`, `now`, `update`) y etapa (sin aprobación,
        `IN_REVIEW`, `AWAITING_FINAL`, `APPROVED` con la misma huella o con otra
        huella, `EXPIRED`).
        *   `inter` siempre sale vacío.
        *   Si la cancelación de workflows falla, el método lanza el error y no
            se escribe nada.
    *   **`beforeChangeDate`:** rechaza las fechas pasadas, conserva
        `APPROVED` y restaura `EXPIRED`.
    *   **`beforeChangePostStatus`:** `schedule` sin aprobación lanza el error;
        `draft` siempre pasa.
    *   **`APPROVALS_ENABLED=false`:** todo pasa sin cambios.

##### 53. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   una prueba por cada fila de la tabla de transiciones;
    *   una prueba por cada regla de autoaprobación;
    *   rechazar sin comentario falla;
    *   forzar sin motivo falla;
    *   la aprobación final con una fecha pasada falla;
    *   `finalApprove` con 3 lotes, uno inválido, devuelve 2 aprobados y 1
        error;
    *   dos aprobaciones finales a la vez sobre el mismo lote: solo una pasa,
        por la actualización condicional;
    *   `submit` sin brief y sin `quickTopic` falla; con `quickTopic` crea un
        brief con `quickBrief = true`.

##### 54. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.sweep.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   cada paso por separado: vencer, avisar a 48 h y a 24 h una sola vez,
        pasar a `PUBLISHED`, avisar de la verificación vencida y conciliar;
    *   ejecutar `run` dos veces seguidas no duplica eventos ni correos;
    *   si un paso falla, los demás se ejecutan igual.

##### 55. `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.approvals.spec.ts` (Create)

*   **Cambios propuestos**: pruebas de cada camino de publicación de la tabla
    del Technical Plan. Usan `PostsService` con el repositorio y Temporal
    simulados.
    *   **Editor, API, MCP:** `createPost` con `schedule` o `now` sobre un lote
        no aprobado guarda `DRAFT` y no inicia el workflow.
    *   **Ajustes:** `updatePostSettings` sobre un lote aprobado, cambiando un
        ajuste, reinicia el lote y cancela los workflows.
    *   **Calendario:** `changeDate('schedule')` sobre un lote aprobado
        conserva `QUEUE`.
    *   **API pública:** `changePostStatus('schedule')` sin aprobación
        responde `400`.
    *   **Plugs:** `checkInternalPlug` y `checkPlugs` devuelven `[]`.
    *   **Posts repetidos:** `createPost` con `inter = 7` guarda
        `intervalInDays = null`.
    *   **Autopost:** crea `DRAFT` y un `PostApproval` en `IN_PRODUCTION`.

### Verification Plan

*   **Compilación**: `pnpm build` desde la raíz. Se aplica el esquema con
    `pnpm prisma-db-push` sobre una base vacía.
*   **Pruebas unitarias**: `pnpm test:fork`.
*   **Análisis estático**: `pnpm lint` desde la raíz, sin
    `eslint-disable-next-line` nuevos.
*   **Chequeo de esquema**: `node scripts/fork/check-schema-additive.mjs
    <upstream.prisma> libraries/nestjs-libraries/src/database/prisma/schema.prisma`
    termina con código 0.
*   **Cobertura**: 90 % o más de ramas en `approval.gate.service.ts` y
    `approval.service.ts`.
*   **Prueba de punta a punta** en un VPS de prueba con `docker compose up`:
    1.  Crear 4 usuarios y asignar los roles. Conectar una página de Facebook,
        una cuenta de Instagram y una página de LinkedIn de prueba.
    2.  Recorrer el CUJ 1 completo y confirmar que se publica en las 3 redes y
        que el historial muestra 5 acciones.
    3.  Recorrer los CUJ 2 a 6 y confirmar el resultado de cada uno.
    4.  Con la API key, ejecutar `POST /public/v1/posts` con `type: schedule` y
        `PUT /public/v1/posts/:id/status` con `schedule`. Confirmar que el post
        queda en `DRAFT` y que la segunda llamada responde `400`.
    5.  Desde la base, poner a mano un post sin aprobar en `QUEUE` con fecha
        dentro de 1 hora. Confirmar que en 15 minutos o menos pasa a `DRAFT` y
        que `approval_reconciled` suma 1.
    6.  Abrir `/p/<id>` sin sesión y confirmar que redirige al login.
    7.  Recrear los contenedores con `docker compose down && docker compose up`
        y confirmar que los posts aprobados siguen programados.

--------------------------------------------------------------------------------

*Drafted with EGM*
