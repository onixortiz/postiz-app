# Flujo de aprobación con 4 roles para un fork de Postiz

*   **Autor:** onix.ortiz.cruz@gmail.com
*   **Estado:** Revisado (EGM, etapas 5 a 9)
*   **Fecha:** 2026-10-28

Las rutas en código en línea son relativas a la raíz del repo `postiz-app/`. Los enlaces son relativos a este archivo. Los encabezados de primer nivel siguen la plantilla del proceso de diseño, en inglés, salvo dos secciones agregadas en español: Glosario y Decisiones tomadas.

--------------------------------------------------------------------------------

## Overview

Un equipo interno va a usar Postiz, una herramienta de código abierto
(AGPL-3.0), para crear, programar y publicar posts en Instagram, Facebook y
LinkedIn, y para revisar sus analíticas. La plataforma corre en un servidor
propio con Docker, a partir de un fork del repo.

El fork agrega dos cosas que Postiz no trae:

1.  **Cuatro roles de trabajo:** Technical Writer, Creator, Reviewer y Monthly
    Reviewer. Se asignan a personas y conviven con los roles que ya tiene
    Postiz (`SUPERADMIN`, `ADMIN`, `USER`).
2.  **Una cadena de aprobación que bloquea la publicación.** Ningún camino de
    publicación conocido pone un lote en `QUEUE` sin la aprobación final del
    Monthly Reviewer. Los caminos están en
    [Cómo cada camino pasa por el punto de control](#cómo-cada-camino-pasa-por-el-punto-de-control).
    La garantía está en el último paso antes de publicar (ver
    [La regla central](#la-regla-central)).

## Glosario

| Término | Significado en este documento |
|---|---|
| **Post raíz** | Fila de `Post` con `parentPostId = null`. Es el primer mensaje de un canal. |
| **Hilo** | Las filas hijas de un post raíz (comentarios o tuits siguientes). |
| **Canal** | Una integración conectada (`Integration`), por ejemplo la página de Facebook del equipo. |
| **Lote** | Todos los posts raíz que comparten `batchId`, es decir, el mismo contenido para varios canales. **Es la unidad de aprobación.** Excepción: el agente MCP crea un lote por canal. |
| **Brief** | Un registro `ContentBrief`: el tema (campo `topic`) y el texto base que escribe el Technical Writer. Un *brief rápido* es el que crea el Creator al enviar un lote sin brief (`quickBrief = true`). El documento de requisitos previo se llama "documento de concepto". |
| **Tema** | Solo el campo `topic` de un brief. |
| **Huella** | Un hash SHA-256 del contenido de un canal: texto, archivos multimedia, retraso y ajustes del post raíz y su hilo. |
| **Estado** | El campo `Post.state` de Postiz (`DRAFT`, `QUEUE`, `PUBLISHED`, `ERROR`). No se cambia. |
| **Etapa** | El paso del flujo en que está un lote (`PostApproval.stage`). Es nuevo y vive en el fork. |
| **Monthly Reviewer** | El aprobador final de cada post. El nombre viene de que además revisa las analíticas cada mes. |
| **Editor** | La ventana de Postiz donde se crea y se edita un post (`manage.modal.tsx`). |
| **Orquestador y Temporal** | El orquestador es el servicio de Postiz (`apps/orchestrator`) que ejecuta los workflows de Temporal. Temporal es el motor de tareas programadas que duerme hasta la hora de publicar y luego publica. |
| **`postWorkflowV112`** | El workflow vigente que publica un post. Postiz no modifica los workflows existentes: crea versiones nuevas. |
| **Tarea de cada hora** | `missingPostWorkflow`. Vuelve a lanzar los posts en `QUEUE` cuya hora pasó en los últimos 2 días. |
| **Plugs** | Acciones automáticas que Postiz ejecuta después de publicar. Los *internos* repostean o comentan desde otras cuentas de la organización. Los *globales* actúan sobre una integración, por ejemplo con una respuesta automática al llegar a cierto número de likes. Su texto no pasa por la cadena de aprobación. |
| **Autopost, clipping, generador** | Funciones de Postiz que crean posts sin intervención de un usuario: desde RSS, desde clips de video y con IA. Todas crean borradores. |
| **`stripLinks`** | Función de algunos proveedores que quita los links del texto antes de guardarlo. |
| **Post (en el flujo)** | Cuando este documento dice que "un post" se envía, se aprueba, vuelve a revisión o vence, se refiere al **lote** completo. "Post raíz" es una sola fila de `Post`. |
| **Terminar (terminate) un workflow** | Detenerlo en Temporal sin que el workflow pueda reaccionar. No es lo mismo que *cancel*, que el workflow puede atrapar. El fork siempre usa *terminate*, nunca *cancel*. |
| **Punto de control** | `ApprovalGateService`: el servicio que aplica la regla central al guardar (`createPost`, `changeDate`, `changePostStatus`, `deletePost`) y al publicar (`isPublishAllowed`, que llama `getPostsList`). En este documento no se usan otros nombres para él. |
| **Upstream** | El repo original de Postiz (`gitroomhq/postiz-app`), del que sale el fork. |
| **Writer** | Forma corta de Technical Writer. |
| **Autor de un lote** | Toda persona que registró `CREATED`, `SUBMITTED` o `CONTENT_EDITED` en el lote. Los autores no pueden aprobar ni forzar ese lote. |
| **Conciliación** | La revisión periódica que compara `Post.state` con la etapa del lote. Un post raíz en `QUEUE` sin aprobación válida pasa a `DRAFT`, y se termina cualquier workflow de un post raíz en `DRAFT`. Corre al arrancar el backend y cada 15 minutos ([Tarea de mantenimiento](#tarea-de-mantenimiento-approvalsweepworkflow)). |

## The Problem

Hoy, en Postiz, cualquier miembro de la organización puede programar un post, y
el post sale solo cuando llega su hora. No hay revisión ni aprobación, y no queda
registro de quién revisó qué.

Para este equipo eso es un problema por tres razones:

*   **Errores públicos.** Un post con un error de texto, una imagen equivocada o
    un tema que no se aprobó sale con el nombre de la marca. En la mayoría de las
    redes no se puede editar después de publicar, y borrarlo no evita que ya se
    haya visto.
*   **La herramienta no distingue las funciones del equipo.** El equipo tiene
    cuatro funciones distintas: definir el tema, producir el post, revisarlo y
    aprobarlo. Postiz las trata a todas igual. No hay forma de saber en qué etapa
    está un post ni a quién le toca.
*   **Los permisos de Postiz no protegen nada en un servidor propio.** Si no está
    configurado Stripe, `PermissionsService.check` le da todos los permisos a
    cualquier usuario
    ([permissions.service.ts:50-63](../../apps/backend/src/services/auth/permissions/permissions.service.ts#L50-L63)).
    Asignar roles tampoco restringiría ninguna acción.

Un intento simple, como esconder el botón "Schedule" o pedir que la gente avise
por chat, no funciona. Hay dos razones:

*   Postiz tiene varios caminos que ponen un post en estado `QUEUE`
    (programado). La lista completa, que es la única lista de referencia del
    documento, está en
    [Cómo cada camino pasa por el punto de control](#cómo-cada-camino-pasa-por-el-punto-de-control).
*   Hay cuatro mecanismos que publican sin intervención de un usuario:

    *   la tarea que corre cada hora (`missingPostWorkflow`) y vuelve a lanzar
        los posts en `QUEUE`;
    *   los posts repetidos;
    *   los plugs (ver el [Glosario](#glosario));
    *   el workflow de publicación, que revisa el estado solo antes de dormir
        hasta la hora de publicar.

**Solución propuesta.** Hacer de la aprobación final una condición para que un
post pueda estar en `QUEUE`, y aplicarla en un único punto de la capa de servicio.
Todo lo que no tenga esa aprobación se queda en `DRAFT`, y Postiz nunca publica un
`DRAFT`. El resto de la cadena (roles, etapas, historial, avisos y vencimiento)
se guarda en tablas nuevas del fork, separadas de las de Postiz.

## Goals

En las metas, "post" significa el lote completo (ver el [Glosario](#glosario)).

1.  **Ningún post se publica sin aprobación final.** Ningún post raíz se publica
    si su lote no tiene aprobación final del Monthly Reviewer para su versión
    actual, por ningún camino, incluidos los que agregue upstream más adelante.
    La única excepción es la publicación de emergencia (meta 8), que también
    guarda una aprobación. Se verifica con una prueba de `getPostsList` y con una
    prueba por cada fila de la
    [tabla de caminos](#cómo-cada-camino-pasa-por-el-punto-de-control).
2.  **Cuatro roles asignables.** Un ADMIN asigna los roles Technical Writer,
    Creator, Reviewer y Monthly Reviewer a cualquier miembro de la organización.
    Un rol puede tener varias personas y una persona puede tener varios roles.
3.  **Cadena en orden.** Un lote recorre estos pasos (la
    [tabla de etapas](#etapas-y-transiciones) tiene el detalle):
    1.  Brief: el Writer lo crea, o el Creator crea un brief rápido al enviar.
        No es una etapa: es un `ContentBrief`.
    2.  Producción (Creator): `IN_PRODUCTION`. Si se rechaza, vuelve a
        `CHANGES_REQUESTED`.
    3.  Revisión (Reviewer): `IN_REVIEW`.
    4.  Aprobación final (Monthly Reviewer): `AWAITING_FINAL`.
    5.  Programado: `APPROVED`, con los posts raíz en `QUEUE`.
    6.  Publicado: `PUBLISHED`.
    7.  Verificado (Writer): `VERIFIED`, o `VERIFICATION_PROBLEM` si el Writer
        marca un problema.

    Cada etapa de aprobación solo la avanza una persona con el rol
    correspondiente.
4.  **Nadie se aprueba a sí mismo.** Nadie aprueba ni fuerza un lote del que es
    autor (ver "Autor de un lote" en el [Glosario](#glosario)). Tampoco puede
    aprobar dos etapas seguidas del mismo lote.
5.  **Cambiar el contenido reinicia la revisión.** Si alguien cambia el texto, los
    archivos multimedia (incluidos su texto alternativo y su portada), los
    canales o los ajustes de un lote ya enviado, el lote vuelve a revisión y se
    terminan (terminate) sus workflows de publicación. Mover solo la fecha a
    otra fecha futura no reinicia nada.
6.  **El rechazo tiene motivo.** Rechazar exige un comentario. El lote vuelve al
    Creator con ese comentario visible.
7.  **Un lote sin aprobación final no se publica al llegar su hora.** Se muestra
    como vencido y se avisa por correo, y también 48 h y 24 h antes. Ningún
    camino de usuario programa un lote con fecha pasada. Hay dos excepciones:
    *   la publicación forzada, que publica de inmediato si la hora ya pasó;
    *   la tarea de cada hora, que vuelve a lanzar los posts aprobados que se
        quedaron en `QUEUE` con la hora ya pasada.
8.  **Hay salida de emergencia, con registro.** El Monthly Reviewer puede forzar
    la publicación escribiendo un motivo, siempre que no haya enviado ni editado
    él mismo la versión actual (meta 4). El motivo queda en el historial y se
    avisa a todo el equipo y, por correo, a los ADMIN.
9.  **Historial de acciones.** Cada acción del flujo queda registrada: quién, con
    qué rol, qué hizo, desde qué superficie (`surface`) y sobre qué versión del
    contenido. También se registran las altas y bajas de roles. Ninguna acción
    borra ni edita una fila del historial.
10. **Bandeja de pendientes por rol.** Cada rol tiene una bandeja de "pendiente
    para mí". El Monthly Reviewer puede aprobar varios lotes de una vez. El
    siguiente rol recibe un correo cuando le llega un lote.
11. **Verificación después de publicar.** El sistema guarda el link del post
    publicado. El Technical Writer tiene 24 h para marcarlo "verificado" o
    "tiene problema"; si no lo hace, el sistema le envía un recordatorio. Marcar
    un problema crea un brief de corrección enlazado.
12. **El texto no aprobado no queda expuesto fuera de la organización.** La
    página de preview y sus comentarios exigen que haya iniciado sesión un
    miembro de la organización.
13. **El fork sigue pudiendo actualizarse desde Postiz.** El código nuevo está en
    carpetas propias. Cada archivo de Postiz que se toca aparece en
    `FORK_TOUCHPOINTS.md`, en la raíz del repo, que se crea con el archivo 50
    del plan. No se cambian los enums `Role` ni `State` de Postiz.

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
*   **Uso comercial o reventa.** Queda fuera del alcance. La AGPL impone
    obligaciones de distribución que no se evaluaron para ese caso.
*   **Migrar posts existentes.** Es una instalación nueva. No hay script de
    migración: la conciliación al arrancar el backend y la de
    `approvalSweepWorkflow` regresan a `DRAFT` cualquier post en `QUEUE` sin
    aprobación.
*   **Agrupar en un lote los posts que crea MCP.** El agente MCP crea un lote por
    canal, y en la v1 esos posts se aprueban canal por canal (ver
    [Risks & Mitigations](#risks--mitigations)).

## Open Questions

*   **Interpretación de la AGPL-3.0.** El equipo interpreta que, para un uso
    interno, basta con que el repo del fork esté disponible para sus usuarios.
    Esa interpretación no tiene revisión legal. **Responsable:** la persona
    dueña del diseño, antes de abrir la plataforma a cualquier persona fuera
    del equipo.

## Decisiones tomadas

Las decisiones que estaban abiertas en el documento de concepto
([concepts_brief.md](approval-workflow/concepts_brief.md)), y las que surgieron al
redactar, se resolvieron así (detalle en el Technical Plan):

*   Garantía al publicar: **la regla central se comprueba en la actividad
    `getPostsList` del orquestador**, justo antes de publicar. Esta decisión
    reemplaza la anterior ("solo el punto de control, sin tocar el
    orquestador"), que se reabrió después de las etapas 5, 8 y 9 de la revisión
    (ver la [alternativa I](#alternativa-i-solo-el-punto-de-control-al-guardar-sin-tocar-el-orquestador)).
*   Huella: **se calcula después de guardar, desde las filas de la base**. Esta
    decisión reemplaza la anterior ("decidir antes de escribir"). El acortador
    de links de Postiz sigue funcionando.
*   Esquema: **`prisma db push` + chequeo en CI** que impide que el fork quite o
    cambie algo de upstream.
*   Brief: **tabla nueva `ContentBrief`**.
*   Lote sin brief: al enviarlo a revisión, el editor le pide al Creator un tema
    de una línea y crea un brief rápido a su nombre (`quickBrief = true`).
    Siempre queda un tema registrado, pero en esos casos no lo definió el
    Writer.
*   Lote vencido: "vencido" **no es una etapa guardada**. Es un valor que se
    calcula: etapa anterior a `APPROVED` y `earliestPublishDate` ya pasada.
    Cuando todos sus posts raíz tienen una fecha futura, deja de estar vencido y
    sigue en su etapa, con las aprobaciones que tenía si el contenido no cambió.
*   Decisión por lote: después de guardar, el punto de control evalúa **el lote
    entero una sola vez**. Ningún canal queda en `QUEUE` mientras otro canal del
    mismo lote cambia.
*   Brief obligatorio del Writer: no se exige. Se usa el brief rápido del
    Creator, que queda marcado.
*   Lote con un canal editado: **se reinicia el lote entero**, porque la unidad
    de aprobación es el lote.
*   Autores del lote: **nadie que haya creado, enviado o editado un lote puede
    aprobarlo ni forzarlo**, sin importar en qué etapa hizo el cambio.
*   Suplantación: **las acciones del flujo se rechazan mientras un superadmin
    suplanta a otro usuario**.
*   Nombres en pantalla: ver la [tabla de etapas](#etapas-y-transiciones).

## Critical User Journeys (CUJs)

### CUJ 1: Un post recorre la cadena completa

*   **Given**: Ana es Technical Writer, Beto es Creator, Carla es Reviewer y Dani
    es Monthly Reviewer. Hay un canal de Instagram y uno de LinkedIn conectados.
*   **When**: Ana escribe el tema y el texto base. Beto arma el post para los dos
    canales, con imagen y fecha del viernes a las 10:00, y lo envía a revisión.
    Carla lo aprueba. Dani lo aprueba desde su bandeja.
*   **Then**: El post pasa a `QUEUE` y se publica el viernes a las 10:00 en las
    dos redes. Ana recibe un correo para verificarlo, abre los links y lo marca
    verificado. El historial muestra, en orden y con nombre, rol y hora, estos
    eventos: `CREATED`, `LINKED_BRIEF`, `SUBMITTED`, `REVIEW_APPROVED`,
    `FINAL_APPROVED`, `PUBLISHED` y `VERIFIED`.

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
*   **Then**: El post vuelve a `DRAFT` y a la etapa de revisión, y se termina su workflow de publicación. Carla recibe un correo. Si en cambio Beto solo hubiera
    arrastrado el post a pasado mañana en el calendario, seguiría aprobado y en
    `QUEUE`, y el cambio de fecha quedaría en el historial.

### CUJ 4: Llega la hora sin aprobación

*   **Given**: Un post programado para hoy a las 15:00 sigue esperando la
    aprobación final.
*   **When**: Pasan las 15:00.
*   **Then**: El post no se publica. Se muestra como "vencido" y el equipo
    recibe un correo. Antes ya se habían enviado avisos 48 h y 24 h antes. Si
    Dani intenta aprobarlo, el sistema lo rechaza por fecha pasada. Para
    seguir, alguien arrastra en el calendario todos los canales del lote a una
    fecha futura, y entonces el lote deja de estar vencido.

### CUJ 5: Un camino automático intenta publicar

*   **Given**: Una integración externa usa la API pública con una API key.
*   **When**: Llama a `POST /public/v1/posts` con tipo `schedule`, o a
    `PUT /public/v1/posts/:id/status` para programar.
*   **Then**: Hay dos casos.
    *   `POST` con `schedule`: el post se crea como borrador en la etapa de
        producción, y la respuesta trae `approvalStage: "IN_PRODUCTION"`.
    *   `PUT .../status` con `schedule` sobre un lote no aprobado: responde
        `400` con el mensaje "Este post necesita aprobación final".

    En ningún caso se publica nada hasta que el post recorre la cadena.

### CUJ 6: Publicación de emergencia

*   **Given**: Hay que publicar un aviso urgente y Carla no está disponible.
*   **When**: Dani, que no envió ni editó el post, elige "Forzar publicación" y
    escribe el motivo.
*   **Then**: Se validan los canales y se guardan las huellas. El post pasa a
    `QUEUE` y se publica a la hora programada, o de inmediato si esa hora ya
    pasó. El historial guarda `FORCED` con el motivo. Todo el equipo recibe el
    aviso, y los ADMIN además un correo.

### CUJ 7: El Monthly Reviewer no está

*   **Given**: Dani es el único Monthly Reviewer y está de vacaciones. Un lote
    espera la aprobación final.
*   **When**: Un ADMIN asigna el rol Monthly Reviewer a Eva, que no es autora
    del lote, desde la pantalla de Equipo.
*   **Then**: El historial registra `ROLE_ASSIGNED` con el ADMIN como actor. Eva
    ve el lote en su bandeja y lo aprueba. Mientras haya un solo Monthly
    Reviewer, la pantalla de Equipo muestra una advertencia de dotación mínima.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### La regla central

> Un post raíz solo puede **publicarse** si su lote está en la etapa `APPROVED`
> y la huella actual de su canal coincide con la huella guardada al aprobar. Un
> post raíz en `PUBLISHED` nunca vuelve a `QUEUE`.

La regla se comprueba en dos lugares, que se apoyan uno en el otro:

1.  **Al publicar (la garantía).** `postWorkflowV112` llama a la actividad
    `getPostsList` una sola vez, después de dormir y justo antes de publicar
    ([post.workflow.v1.1.2.ts:182-187](../../apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts#L182-L187)).
    Esa actividad ya devuelve `[]` cuando falta la suscripción de Stripe
    ([post.activity.ts:175-181](../../apps/orchestrator/src/activities/post.activity.ts#L175-L181)),
    y entonces el workflow termina en `ERROR 'No Post'` sin publicar nada. El
    fork agrega, con el mismo patrón, una llamada a
    `ApprovalGateService.isPublishAllowed(orgId, postId)`: si devuelve `false`,
    `getPostsList` devuelve `[]`. Solo cambia el cuerpo de la actividad, no sus
    parámetros ni ningún workflow, así que cumple la regla de `CLAUDE.md`. La
    comprobación corre también con `postNow`, así que cubre los posts
    repetidos y cualquier workflow iniciado por fuera de Postiz.
2.  **Al guardar (la experiencia).** Los tres métodos de `PostsService` que
    escriben `QUEUE` (`createPost`, `changeDate` y `changePostStatus`) consultan
    la misma regla para decidir si dejan el post en `QUEUE` o en `DRAFT`, o si
    responden `400`. Esto evita que un post sin aprobar quede programado y
    termine en `ERROR` a la hora de publicar. `deletePost` también pasa por el
    punto de control, para registrar el borrado de canales.
    `updatePostSettings` no escribe por su cuenta: llama a
    `createPost('update')`.

Como la garantía está en el último punto antes de publicar, el diseño ya no
depende de encontrar y vigilar cada camino de Postiz que escribe en `Post`, ni
de terminar a tiempo los workflows que quedaron dormidos. Un camino nuevo que
agregue upstream, una carrera entre una aprobación y una edición, o un workflow
iniciado a mano en Temporal terminan igual: el post no se publica, queda en
`ERROR 'No Post'`, y la conciliación lo devuelve a `DRAFT` y avisa a los ADMIN.

### Diagrama

```text
  Editor web   Calendario   API pública / SDK / CLI   Agente MCP
       │            │                  │                  │
       └────────────┴─────────┬────────┴──────────────────┘
                              ▼
     PostsService.createPost / changeDate / changePostStatus / deletePost
     (updatePostSettings llama a createPost('update'))
                              │
                              ▼  guarda (schedule/now → draft)
        PostsRepository.createOrUpdatePost / changeDate / changeState
                              │
                              ▼  después de guardar
                 ┌────────────────────────────┐
                 │   ApprovalGateService      │◄── PostApproval (etapa, huellas)
                 │   afterSave: huella desde  │
                 │   las filas; si aprobado y │
                 │   sin cambios → QUEUE      │
                 └─────────────┬──────────────┘
                               ▼
              state = QUEUE → startWorkflow → postWorkflowV112 (sin cambios)
                                                   │ duerme hasta la hora
                                                   ▼
                       getPostsList (actividad, cuerpo modificado)
                       └─ isPublishAllowed? no → [] → ERROR 'No Post'
                                            sí → la red publica

  ApprovalsController (web, con sesión, sin suplantación) ──► ApprovalService
       enviar / aprobar / rechazar / forzar / verificar
       │  valida el rol con ApprovalPolicyService
       │  cambia la etapa con control de versión y escribe PostApprovalEvent
       │  (ApprovalsRepository.transition, una transacción)
       └► en la aprobación final: changePostStatus('schedule') por cada post raíz
          que no esté PUBLISHED

  approvalSweepWorkflow (Temporal, nuevo, cada 15 min; también al arrancar)
       ├─ avisa una vez de los lotes no aprobados cuya hora pasó
       ├─ avisa 48 h y 24 h antes de vencer
       ├─ marca PUBLISHED cuando todos los canales que quedan salieron
       ├─ avisa si la verificación lleva más de 24 h pendiente
       └─ concilia:
          ├─ ERROR 'No Post' en un lote sin aprobación válida → DRAFT,
          │  BLOCKED_AT_PUBLISH y correo a los ADMIN
          ├─ QUEUE sin aprobación válida → DRAFT (evita un ERROR más tarde)
          └─ lotes sin PostApproval y canales borrados por Postiz → se registran
```

### Modelo de datos (tablas nuevas)

Las cuatro tablas van en un bloque marcado `// ==== FORK: approvals ====` al
final de [schema.prisma](../../libraries/nestjs-libraries/src/database/prisma/schema.prisma).
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
| `createdAt` | fecha | |

*   Quitar un rol **borra la fila**. Prisma 6.5 no puede expresar un índice
    único parcial sobre filas no borradas, y `CLAUDE.md` prohíbe el SQL crudo.
*   Cada alta y cada baja quedan en `PostApprovalEvent` con las acciones
    `ROLE_ASSIGNED` y `ROLE_REMOVED`, sin `approvalId`.
*   Hay un índice `@@unique([organizationId, userId, role])`.
*   Una persona puede tener varias filas, una por rol.

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
| `version` | entero, empieza en 0 | Control de concurrencia optimista. Todo cambio de etapa y todo reinicio usa `updateMany where { id, version }` y suma 1. Si no se actualiza ninguna fila, alguien cambió el lote antes y la acción responde `409`. |
| `approvedFingerprints` | JSON `{ [integrationId]: sha256 }` | Se llena en la aprobación final y se borra al reiniciar. Es lo que consulta la regla central. Las huellas de las etapas anteriores se leen del historial: `PostApprovalEvent.fingerprints` del último `SUBMITTED`, `RESET_BY_EDIT` o `REVIEW_APPROVED`. |
| `earliestPublishDate` | fecha | La fecha más temprana entre los posts raíz del lote. Se recalcula en cada guardado. Con ella se calcula si el lote está vencido. |
| `forced` | booleano | `true` si el Monthly Reviewer forzó la publicación. |
| `warned48At`, `warned24At`, `warnedExpiredAt` | fechas, opcionales | Evitan que un aviso previo o de vencimiento se repita. Se borran cuando cambia `earliestPublishDate`. |
| `verifyDueAt` | fecha, opcional | Plazo para verificar (publicación + 24 h). No se borra al cambiar la fecha. |
| `warnedVerifyAt` | fecha, opcional | Marca que ya se avisó de la verificación vencida. |
| `verifiedAt`, `verifiedById` | fecha, → User, opcionales | |
| `createdAt`, `updatedAt` | fecha | |

**`PostApprovalEvent`**: el historial. Solo se insertan filas.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `organizationId` | uuid, → Organization | |
| `approvalId` | → PostApproval, opcional | Vacío en `ROLE_ASSIGNED` y `ROLE_REMOVED`. |
| `actorUserId` | → User, opcional | Vacío para las acciones del sistema y para la API con API key. |
| `actorRole` | enum `ActorRole` | `TECHNICAL_WRITER`, `CREATOR`, `REVIEWER`, `MONTHLY_REVIEWER`, `MEMBER` (alguien sin rol de trabajo, por ejemplo al editar) o `SYSTEM`. |
| `action` | enum `ApprovalAction` | `CREATED`, `LINKED_BRIEF`, `SUBMITTED`, `REVIEW_APPROVED`, `FINAL_APPROVED`, `REJECTED`, `CONTENT_EDITED` (cambió la huella, en cualquier etapa), `RESET_BY_EDIT`, `DATE_CHANGED`, `EXPIRED` (aviso de vencimiento enviado), `FORCED`, `PUBLISHED`, `VERIFIED`, `VERIFICATION_PROBLEM`, `BLOCKED` (se pidió `schedule` o `now` y el lote no estaba aprobado), `BLOCKED_AT_PUBLISH` (`getPostsList` impidió una publicación), `RECONCILED`, `CHANNEL_DISCARDED`, `ROLE_ASSIGNED` y `ROLE_REMOVED`. |
| `surface` | enum `CreationMethod` de Postiz | `WEB`, `API`, `MCP`, `CLI`, etc. |
| `fingerprints` | JSON | Las huellas en ese momento. |
| `snapshot` | JSON | El texto y la media de cada canal en ese momento. |
| `commentId` | → Comments, opcional | Obligatorio en `REJECTED` y `VERIFICATION_PROBLEM`. |
| `reason` | texto, opcional | Obligatorio en `FORCED`, `REJECTED` y `VERIFICATION_PROBLEM`. En los dos últimos guarda una copia del texto del comentario, porque `Comments` es una tabla de Postiz que se puede editar. En `RECONCILED` vale `'startup'` cuando lo registra la conciliación al arrancar. |
| `targetUserId`, `targetRole` | → User, `WorkflowRole`, opcionales | Solo en `ROLE_ASSIGNED` y `ROLE_REMOVED`. |
| `createdAt` | fecha | |

### Etapas y transiciones

| Etapa (`stage`) | Nombre en pantalla | `Post.state` permitido |
|---|---|---|
| `IN_PRODUCTION` | En producción | `DRAFT` |
| `IN_REVIEW` | En revisión | `DRAFT` |
| `AWAITING_FINAL` | Esperando aprobación final | `DRAFT` |
| `CHANGES_REQUESTED` | Cambios pedidos | `DRAFT` |
| `APPROVED` | Aprobado | `QUEUE`, `DRAFT` (en pausa) o `ERROR` (reintento pendiente) |
| `PUBLISHED` | Publicado – falta verificar | `PUBLISHED` |
| `VERIFIED` | Verificado | `PUBLISHED` |
| `VERIFICATION_PROBLEM` | Publicado con problema | `PUBLISHED` |

**En pausa:** alguien pasó el post raíz a borrador con
`changePostStatus('draft')` sin cambiar el contenido. Se reanuda con `schedule`
sin aprobación nueva si la huella no cambió y la fecha es futura.

**Vencido** no es una etapa. La pantalla muestra "Vencido" junto a la etapa real
cuando esa etapa es anterior a `APPROVED` y `earliestPublishDate < ahora`. Como
`earliestPublishDate` es la fecha más temprana del lote, el lote deja de estar
vencido cuando **todos** sus posts raíz tienen una fecha futura. Si el
calendario mueve un solo canal, los demás siguen vencidos.

| Desde | Acción | Quién | Hacia | Condición |
|---|---|---|---|---|
| (nada) | Primer guardado de un lote | Cualquiera | `IN_PRODUCTION` | Se crea `PostApproval`, se registra `CREATED` con el actor y el post queda en `DRAFT` aunque se haya pedido `schedule`. |
| (nada) | Conciliación encuentra un lote sin `PostApproval` (por ejemplo, creado con `APPROVALS_ENABLED=false`) | Sistema | `IN_PRODUCTION` | Se crea `PostApproval`, se registra `CREATED` con `actorRole = SYSTEM` y sus posts raíz que no estén en `PUBLISHED` pasan a `DRAFT`. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED` | Enviar a revisión | Creator | `IN_REVIEW` | Todos los canales pasan la validación de Postiz (`validatePosts`). Si el lote no tiene brief, la petición trae un `quickTopic` de una línea y se crea un `ContentBrief` con `quickBrief = true` a nombre del Creator. Sin brief y sin `quickTopic`, se rechaza. |
| `IN_REVIEW` | Aprobar | Reviewer | `AWAITING_FINAL` | El actor no es autor del lote (ver [Glosario](#glosario)). La petición trae la `version` que vio el actor. La huella actual coincide con la del último `SUBMITTED` o `RESET_BY_EDIT`. El evento `REVIEW_APPROVED` guarda las huellas. |
| `IN_REVIEW`, `AWAITING_FINAL` | Rechazar | Reviewer o Monthly Reviewer | `CHANGES_REQUESTED` | Comentario obligatorio. |
| `AWAITING_FINAL` | Aprobación final | Monthly Reviewer | `APPROVED` | El actor no aprobó la etapa anterior y no es autor del lote. La `version` coincide y todas las fechas de los posts raíz que no están en `PUBLISHED` están en el futuro. Se guardan las huellas. Cada post raíz que **no** esté en `PUBLISHED` pasa a `QUEUE`. Si entra una edición al mismo tiempo, `getPostsList` impide la publicación. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED`, `IN_REVIEW`, `AWAITING_FINAL` | Forzar publicación | Monthly Reviewer | `APPROVED` | Motivo obligatorio. El actor no es autor del lote, así que nadie puede crear un lote y forzarlo solo. Todos los canales pasan `validatePosts`. Se guardan las huellas actuales en `approvedFingerprints` y `forced = true`. Los posts raíz que no estén en `PUBLISHED` pasan a `QUEUE`. Con fecha futura, se publican a su hora. Con fecha pasada, `ApprovalService` primero mueve la fecha a ahora más un minuto con `changeDate('update')` y después programa. Avisa a todo el equipo y manda un correo a los ADMIN. |
| `IN_REVIEW`, `AWAITING_FINAL`, `APPROVED` | Cambio de contenido (la huella cambia) | Cualquiera, desde cualquier superficie | `IN_REVIEW` | Se registra `CONTENT_EDITED` con el autor (vacío si fue con API key). Se borra `approvedFingerprints`, todo el lote pasa a `DRAFT`, se terminan sus workflows y se registra `RESET_BY_EDIT` con las huellas nuevas, que son la referencia de la siguiente aprobación. A los Reviewer se les avisa como máximo una vez cada 15 minutos por lote. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED` | Cambio de contenido (la huella cambia) | Cualquiera, desde cualquier superficie | (sin cambio de etapa) | Solo se registra `CONTENT_EDITED` con el autor y las huellas nuevas. |
| `APPROVED` | Pausar un canal (`changePostStatus('draft')`) | Cualquiera | `APPROVED` | El post raíz pasa a `DRAFT` sin cambiar el contenido. |
| `APPROVED` | Reanudar un canal en pausa (`schedule`) | Cualquiera | `APPROVED` | Solo si la huella del canal no cambió y la fecha es futura. |
| `APPROVED` | Reintentar un canal en `ERROR` (`changeDate('schedule')` o `changePostStatus('schedule')`) | Cualquiera | `APPROVED` | Solo si la huella del canal no cambió y la fecha es futura. |
| `APPROVED` | Solo cambio de fecha a una fecha futura | Cualquiera | `APPROVED` | Se registra `DATE_CHANGED`. Una fecha pasada se rechaza. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED`, `IN_REVIEW`, `AWAITING_FINAL` | Pasa `earliestPublishDate` | Sistema | (sin cambio de etapa) | Se registra `EXPIRED`, se avisa y se marca `warnedExpiredAt`. |
| `IN_PRODUCTION`, `CHANGES_REQUESTED`, `IN_REVIEW`, `AWAITING_FINAL`, vencido | Cambio de fecha a una fecha futura | Cualquiera | (sin cambio de etapa) | Se recalcula `earliestPublishDate`. Si todos los posts raíz quedaron en el futuro, deja de estar vencido y se borran las marcas de aviso. |
| `APPROVED` | Borrar un canal en `ERROR`, en pausa o ya en `PUBLISHED` (`deletePost` desde el calendario) | Cualquiera | `APPROVED` | `afterDeletePost` registra `CHANNEL_DISCARDED` con el actor. **No reinicia el lote**, porque lo que publican los demás canales no cambia. Lo mismo cuando se borra el último canal del lote. |
| `IN_REVIEW`, `AWAITING_FINAL`, `APPROVED` | Borrar cualquier otro canal del lote (`deletePost`) | Cualquiera | `IN_REVIEW` | Cuenta como cambio de contenido: se registra `CONTENT_EDITED` y `RESET_BY_EDIT`, y se terminan los workflows de los demás canales. |
| `APPROVED` | Todos los posts raíz que quedan están en `PUBLISHED` | Sistema | `PUBLISHED` | `verifyDueAt = ahora + 24 h`. Se avisa al Writer. Mientras quede un canal en `ERROR` o en pausa, el lote sigue en `APPROVED` y ese canal se puede reintentar o descartar. |
| `PUBLISHED` | Verificar | Technical Writer | `VERIFIED` | |
| `PUBLISHED` | Marcar problema | Technical Writer | `VERIFICATION_PROBLEM` | Comentario obligatorio. Se crea un `ContentBrief` con `correctionOfApprovalId`. |

**Un canal con error.** Si un canal de un lote aprobado termina en `ERROR`, el
lote se queda en `APPROVED`. Cualquiera puede reintentar reprogramándolo
(`changeDate` o `changePostStatus('schedule')`). Pasa sin aprobación nueva
mientras la huella no cambie y la fecha sea futura. La pantalla muestra el
estado de cada canal.

**Canales ya publicados.** Un post raíz en `PUBLISHED` no vuelve a `QUEUE` por
ningún camino del flujo:

*   La aprobación final, la publicación forzada y los reintentos lo saltan.
*   Su huella queda fuera de la comparación del reinicio.
*   Editarlo sigue la regla de Postiz, con `type: update`, que no republica.
*   Con el fork activo, `republish: true` se rechaza **solo** si el post raíz
    está en `PUBLISHED`. En cualquier otro estado se ignora. El calendario manda
    esa marca en todo arrastre con `schedule`
    ([calendar.tsx:917](../../apps/frontend/src/components/launches/calendar.tsx#L917)),
    así que rechazarla siempre rompería los arrastres de los CUJ 3 y 4.
*   `changeDate`, `changePostStatus` y `createPost` rechazan cualquier pedido
    que dejaría en `QUEUE` un post raíz en `PUBLISHED`, aunque antes se le haya
    cambiado la fecha con `action: 'update'`.

### Huella del contenido

*   Hay una huella por canal (`integrationId`) dentro del lote.
*   **Se calcula siempre desde las filas guardadas en la base**, con una sola
    función: `ApprovalGateService.fingerprintsFromDb(orgId, batchId)`. No hay un
    segundo cálculo desde el cuerpo de la petición. Por eso no hace falta
    copiar `stripLinks`, forzar `shortLink = false` ni repetir el criterio de
    lote de upstream: lo que se compara es lo que Postiz guardó.
*   **Entra en la huella:** para el post raíz y cada hijo, en orden:
    *   el `content`;
    *   la lista de archivos multimedia. Cada archivo se identifica por el `id`
        de la biblioteca si hay una fila de `Media` con ese `id` (aunque tenga
        `deletedAt`), y por su `path` solo si no la hay. Además se incluyen
        `alt` (texto alternativo) y `thumbnail` (portada de video), tomados
        **solo del post**;
    *   el `delay`;
    *   los `settings` del canal, con las claves ordenadas.
*   **Reglas para que las reescrituras de Postiz no cambien la huella.**
    `updateMedia` reescribe la lista de archivos al abrir el editor y al
    publicar
    ([posts.service.ts:506-611](../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L506-L611)):
    *   la ruta de un archivo de la biblioteca no entra en la huella, porque el
        normalizador puede cambiarla;
    *   a la ruta de un archivo que no está en la biblioteca se le quita el
        prefijo `process.env.UPLOAD_DIRECTORY` cuando no contiene `http`, que es
        el único prefijo que `updateMedia` antepone a `path`
        ([posts.service.ts:535-550](../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L535-L550));
    *   se quitan los archivos que no pasan `isAllowedMediaPath`. Esa función es
        privada en `PostsService`, así que se mueve a
        `libraries/helpers/src/utils/is.allowed.media.path.ts` y `PostsService`
        la importa desde ahí (cambio registrado en `FORK_TOUCHPOINTS.md`);
    *   `alt` y `thumbnail` vacíos cuentan como el valor propio "ausente", y
        nunca se completan con la fila de `Media`. En un archivo de la
        biblioteca, un `alt` o `thumbnail` igual al de su fila de `Media`
        también cuenta como ausente: `updateMedia` reemplaza un archivo con
        `id` y sin `path` por la fila completa;
    *   el prefijo `UPLOAD_DIRECTORY` se quita tantas veces como aparezca,
        porque cada reescritura de `updateMedia` lo vuelve a anteponer.
    *   **Límite conocido:** con `convertToJPEG`, `updateMedia` vuelve a subir
        al publicar los PNG que no están en la biblioteca y guarda la ruta
        nueva. Si esa publicación falla, el reintento de ese canal necesita
        una aprobación nueva. Los archivos de la biblioteca no tienen este
        problema, porque su huella usa el `id`.
*   **Valores por defecto:** `delay` ausente vale 0; en `settings` se quitan las
    claves con `undefined`, `null`, `''` o `[]`, y la clave `__type`.
*   **No entra:** `url`, `type` y `name` de la media, `publishDate`, `state`,
    `releaseId`, `releaseURL`, `error`, etiquetas, `group` ni ids de fila. Esos
    campos no cambian lo que se publica, o los escribe el sistema.
*   **Agregar o quitar un canal** del lote cuenta como cambio de contenido.
    Agregar es un canal nuevo que aparece en el lote; quitar es `deletePost`
    sobre un canal que no está en `ERROR` ni en pausa. Un cuerpo que trae solo
    algunos canales del lote **no** cuenta como quitar los demás.

**Huella de referencia.** Es la única definición del documento; las demás
secciones la citan.

*   En `APPROVED`: `PostApproval.approvedFingerprints`, que guardan la
    aprobación final y la publicación forzada.
*   En las demás etapas: las huellas del último evento que las guardó, entre
    `CREATED`, `CONTENT_EDITED`, `SUBMITTED`, `RESET_BY_EDIT` y
    `REVIEW_APPROVED`. Todos esos eventos guardan las huellas de todos los
    canales del lote.

### Cómo cada camino pasa por el punto de control

**Decidir después de guardar.** Con el fork activo, `createPost` sigue estos
pasos:

1.  **Tipo por canal.** Antes del bucle, `ApprovalGateService.typeForSave` da un
    tipo para cada canal del cuerpo:
    *   si el post raíz ya está en `PUBLISHED`: `update` (nunca se
        reprograma). `republish: true` se rechaza con `400` en ese caso;
    *   si se pidió `schedule` o `now`: `draft`;
    *   en otro caso: el tipo pedido.

    `inter` siempre sale vacío (sin posts repetidos). `schedule` con una fecha
    pasada se rechaza con `400` ("La fecha de publicación ya pasó"), salvo para
    los canales en `PUBLISHED`.
2.  **Guardar.** El bucle de Postiz guarda cada canal con su tipo. Como ningún
    canal se guarda con `schedule` ni `now`, `startWorkflow` recibe `DRAFT` y
    termina los workflows que hubiera, como ya hace Postiz
    ([posts.service.ts:944-967](../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L944-L967)).
    El `batchId` lo resuelve Postiz como siempre.
3.  **Decidir.** Después del bucle, `ApprovalGateService.afterSave` lee los
    lotes de los posts guardados (puede haber más de uno si el cuerpo mezclaba
    lotes) y, para cada lote:
    *   crea el `PostApproval` con `CREATED` si no existía;
    *   calcula la huella desde las filas y la compara con la huella de
        referencia;
    *   si cambió, registra `CONTENT_EDITED` y, si la etapa era `IN_REVIEW`,
        `AWAITING_FINAL` o `APPROVED`, aplica el reinicio (ver la
        [tabla de transiciones](#etapas-y-transiciones));
    *   si no cambió, el lote está `APPROVED` y se pidió `schedule` o `now`,
        devuelve los posts raíz que hay que volver a programar. `createPost` los
        pasa a `QUEUE` con `changeState` y llama a `startWorkflow`.
4.  **Si el bucle falla a la mitad,** un bloque `finally` llama igual a
    `afterSave`. Como lo guardado quedó en `DRAFT`, nada se programa sin
    comparar la huella.

No hace falta ordenar escrituras ni terminar workflows de forma estricta: si un
workflow sobrevive a la terminación de Postiz, o si entra una edición mientras
se aprueba, la comprobación de `getPostsList` impide la publicación.

| Camino | Método de `PostsService` | Qué hace el punto de control |
|---|---|---|
| Editor web: Guardar / Programar / Post Now | `createPost` (`draft`, `schedule`, `now`) | Guarda como `draft` y, después, vuelve a programar solo si el lote está aprobado y la huella no cambió. |
| Edición que mantiene el estado | `createPost` (tipo `update`) | Guarda y compara la huella después. Si cambió en un lote aprobado, reinicia y pasa el lote a `DRAFT`. |
| Ajustes por API o MCP | `updatePostSettings` → `createPost('update')` | Lo cubre la fila anterior. Los ajustes forman parte de la huella. |
| Calendario: arrastrar | `changeDate` con `action: 'schedule'` | Rechaza las fechas pasadas y los posts raíz en `PUBLISHED`. Ignora `republish: true` salvo en `PUBLISHED`. Si el resultado sería `QUEUE`, exige `isPublishAllowed`; si no se cumple, el post queda en `DRAFT`. Recalcula `earliestPublishDate` **después** de escribir. |
| Cambio de fecha sin reprogramar | `changeDate` con `action: 'update'` (valor por defecto de `PUT /posts/:id/date`, [posts.controller.ts:303](../../apps/backend/src/api/routes/posts.controller.ts#L303)) | Si el post raíz está en `QUEUE`, se convierte en `schedule` para que el workflow se reinicie con la fecha nueva. En `PUBLISHED`, solo cambia la fecha guardada. |
| API pública: crear post | `createPost` vía [public.integrations.controller.ts:230](../../apps/backend/src/public-api/routes/v1/public.integrations.controller.ts#L230) | Igual que el editor. La respuesta agrega `approvalStage`. |
| API pública: cambiar estado | `changePostStatus` ([public.integrations.controller.ts:643](../../apps/backend/src/public-api/routes/v1/public.integrations.controller.ts#L643)) | `schedule` sin `isPublishAllowed` responde `400` ("Este post necesita aprobación final"); con fecha pasada, `400` ("La fecha de publicación ya pasó"). `draft` siempre se permite. |
| SDK y CLI | Usan la API pública | Igual que la API pública. |
| Agente MCP: programar | `createPost` vía [integration.schedule.post.ts:256](../../libraries/nestjs-libraries/src/chat/tools/integration.schedule.post.ts#L256) | Igual que el editor. **Límite de la v1:** MCP llama a `createPost` una vez por canal, así que cada canal queda en su propio lote. |
| Autopost, clipping, generador | `createPost` con tipo `draft` | Sin cambios de comportamiento. Se crea el `PostApproval` en `IN_PRODUCTION`. |
| Posts repetidos | `body.inter` | `inter` siempre sale vacío. |
| Plugs internos y globales | `checkInternalPlug` y `checkPlugs` ([posts.service.ts:822-895](../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L822-L895)), que llama el orquestador | Con el fork activo, ambos devuelven `[]`. Los endpoints para crear o activar plugs responden `400`. |
| Tarea de cada hora | Relanza posts en `QUEUE` | Pasan por `getPostsList`, así que un post sin aprobación no se publica. |
| Reintento de un canal en `ERROR` o en pausa | `changeDate('schedule')` o `changePostStatus('schedule')` | Pasa solo si `isPublishAllowed` y la fecha es futura. |
| Borrar un canal | `deletePost` | `beforeDeletePost` registra `CHANNEL_DISCARDED` si el canal está en `ERROR` o en pausa en un lote `APPROVED` (no reinicia). En otro caso cuenta como cambio de contenido. |
| Borrado de posts por Postiz | `updateMany` al reconectar un canal o borrar una cuenta ([integration.repository.ts:199-206](../../libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts#L199-L206) y 832-840), y `deletePost` con `.catch(() => {})` en `integrations.controller.ts:461`, `public.integrations.controller.ts:558` y `enterprise.controller.ts:148` | No publican nada. La conciliación detecta los posts raíz borrados y registra `CHANNEL_DISCARDED` con `actorRole = SYSTEM`. |
| Acceso directo a Temporal | gRPC 7233 o UI 8080 | Un workflow iniciado a mano, aun con `postNow`, pasa por `getPostsList` y no publica sin aprobación. Además, los puertos no se publican fuera del host (defensa en profundidad, ver [Despliegue](#despliegue)). |
| Aprobación final | `ApprovalService.finalApprove` → `changePostStatus('schedule')` por cada post raíz que no esté en `PUBLISHED` | Pasa porque el lote ya está aprobado. |

### Roles y permisos

*   `ApprovalPolicyService` valida cada acción del flujo con
    `WorkflowRoleAssignment` y el historial. Las reglas son tres:
    *   cada acción exige su rol;
    *   no puede aprobar ni forzar un autor del lote (ver
        [Glosario](#glosario));
    *   nadie aprueba dos etapas seguidas.

    No usa `@CheckPolicies` (ver The Problem).
*   Asignar y quitar roles de trabajo exige `UserOrganization.role` igual a
    `ADMIN` o `SUPERADMIN`. Se lee directo de la base.
*   Las acciones del flujo (enviar, aprobar, rechazar, forzar, verificar) **solo**
    se aceptan desde `ApprovalsController`, que está detrás de la sesión web
    normal (`GetUserFromRequest`).
*   **Suplantación.** Un superadmin puede suplantar a otro usuario con la cookie
    o el header `impersonate`, y entonces `req.user` pasa a ser la persona
    suplantada
    ([auth.middleware.ts:60-75](../../apps/backend/src/services/auth/auth.middleware.ts#L60-L75)).
    Cuando se cumple la misma condición que en el middleware
    (`req.user.isSuperAdmin` y `req.cookies.impersonate` o
    `req.headers.impersonate`), `ApprovalsController` rechaza con `403` todas
    las acciones del flujo y la asignación de roles. Esta copia de la condición
    queda registrada en `FORK_TOUCHPOINTS.md`. Las ediciones
    hechas con suplantación quedan como `CONTENT_EDITED` a nombre de la persona
    suplantada, así que esa persona queda excluida de aprobar. La API pública, el SDK y MCP no tienen esos
    endpoints. Solo crean y editan posts, que quedan como borradores.
*   Ver y editar posts sigue igual que en Postiz: todos los miembros ven y editan
    todo.

### Avisos

*   Se usa `NotificationService`, que ya existe
    ([notification.service.ts:41-115](../../libraries/nestjs-libraries/src/database/prisma/notifications/notification.service.ts#L41-L115)).
    No se crea un sistema de avisos nuevo.
*   **Avisos a un rol.** Cuando un lote cambia de etapa:
    *   se crea un aviso interno con `inAppNotification(orgId, subject, text,
        false)`. El panel de avisos muestra texto plano y solo convierte URLs
        en enlaces (`notification.component.tsx:11-48`), así que `text` lleva
        la etapa, el tema y la URL del post en texto plano, sin etiquetas.
        Nunca lleva el texto del post ni el de un comentario de rechazo;
    *   se envía un correo con `sendEmail(to, subject, html)` a cada persona
        con el rol que sigue. El correo sí puede llevar HTML, porque es un texto
        distinto del aviso interno.
*   **Avisos a todo el equipo** (`EXPIRED`, `FORCED` y `VERIFICATION_PROBLEM`):
    se usa `inAppNotification(orgId, subject, html, true, false, 'info')`. Se
    usa el tipo `'info'` porque es el único que se envía siempre: con el tipo
    por defecto (`'success'`), Postiz se salta a quien apagó ese tipo de correo
    ([notification.service.ts:96-101](../../libraries/nestjs-libraries/src/database/prisma/notifications/notification.service.ts#L96-L101)).
*   **El aviso interno lo ve toda la organización.** Postiz no tiene avisos por
    persona. Lo que señala a quien le toca es el correo directo.
*   **Correo a los ADMIN:** cada `FORCED` y cada `RECONCILED` envía también un
    correo directo a los ADMIN y SUPERADMIN de la organización.
*   **A quién le llega:** en `IN_REVIEW`, a los Reviewer; en `AWAITING_FINAL`, a
    los Monthly Reviewer; en `CHANGES_REQUESTED`, a quien envió el lote; en
    `PUBLISHED`, a los Technical Writer. Los avisos de 48 h y 24 h van a las
    personas con el rol de la etapa actual del lote (en `IN_PRODUCTION` y
    `CHANGES_REQUESTED`, a los Creator).
*   Si `hasEmailProvider()` devuelve `false`, solo funcionan los avisos
    internos, y el servidor escribe una advertencia en el log al arrancar.

### Tarea de mantenimiento (`approvalSweepWorkflow`)

*   Es un workflow nuevo de Temporal con la forma de
    [missing.post.workflow.ts](../../apps/orchestrator/src/workflows/missing.post.workflow.ts):
    hace un paso al empezar y después entra en un bucle que duerme 15 minutos y
    hace otro paso. Llama a `continueAsNew` cada 96 vueltas (24 h) o cuando el
    historial pasa de 1000 eventos.
*   Lo arranca el **backend**, junto a `missingPostWorkflow`, desde
    [infinite.workflow.register.ts](../../libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts),
    que se carga en `apps/backend/src/app.module.ts`. Solo arranca cuando
    `RUN_CRON` está definida, y siempre con el ID fijo `approval-sweep-workflow`.
*   **Con `APPROVALS_ENABLED=false` no hace nada.** `run()` y `reconcile()`
    salen sin hacer cambios. El workflow sigue durmiendo, así que reactivar el
    fork no necesita volver a arrancarlo.
*   Al arrancar, con `APPROVALS_ENABLED=true`, el backend además lanza **una
    conciliación** en `onModuleInit`, en segundo plano y con hasta 3 reintentos.
    No bloquea el arranque y es idempotente si hay varias réplicas. Registra
    `RECONCILED` con `reason: 'startup'`, que no cuenta como alerta. Si falta
    `RUN_CRON`, escribe un error en el log.
*   Llama a una sola actividad nueva, `approvalSweep()`, en un archivo de
    actividad nuevo. Esa actividad delega en `ApprovalSweepService`, que está en
    `libraries/nestjs-libraries`.
*   **Cada paso:**

    | # | Condición | Acción | Evento | Aviso |
    |---|---|---|---|---|
    | 1 | Etapa anterior a `APPROVED`, `earliestPublishDate < ahora`, `warnedExpiredAt` vacío | Marca `warnedExpiredAt`. La etapa no cambia. | `EXPIRED` | A todo el equipo (`'info'`) |
    | 2 | Etapa anterior a `APPROVED`, `ahora < earliestPublishDate <= ahora + 48 h` (o 24 h), marca vacía | Marca `warned48At` o `warned24At`. | — | Al rol de la etapa actual (Creator en `IN_PRODUCTION` y `CHANGES_REQUESTED`) |
    | 3 | Lote `APPROVED` cuyos posts raíz restantes están todos en `PUBLISHED` | Pasa a `PUBLISHED`, fija `verifyDueAt = ahora + 24 h` y marca el brief como `DONE`. | `PUBLISHED` | A los Technical Writer |
    | 4 | `verifyDueAt < ahora`, `warnedVerifyAt` vacío | Marca `warnedVerifyAt`. | — | A los Technical Writer y Monthly Reviewer |
    | 5a | Post raíz en `ERROR` con `error = 'No Post'` cuyo lote no cumple la regla central | Pasa a `DRAFT`. Si el lote estaba `APPROVED`, lo devuelve a `IN_REVIEW`. | `BLOCKED_AT_PUBLISH` | Correo a los ADMIN, salvo que la causa sea solo un cambio de huella sin `CONTENT_EDITED` (`reason: 'fingerprint_drift'`), que va a los Monthly Reviewer |
    | 5b | Post raíz en `QUEUE` cuyo lote no cumple la regla central | Pasa a `DRAFT` con `startWorkflow(DRAFT)` de Postiz, que termina su workflow. | `RECONCILED` | Correo a los ADMIN (salvo `reason: 'startup'`) |
    | 5c | Post raíz en `ERROR` en un lote anterior a `APPROVED` (por ejemplo, un workflow que ganó una carrera y terminó en `'Already posted'`) | Pasa a `DRAFT`. | `RECONCILED` | — |
    | 5d | Lote con posts y sin `PostApproval` | Crea `PostApproval` en `IN_PRODUCTION`. Sus posts raíz que no están en `PUBLISHED` pasan a `DRAFT`. | `CREATED` con `actorRole = SYSTEM` | — |
    | 5e | Un `integrationId` de la huella de referencia sin post raíz no borrado, sin evento de borrado | Registra el borrado. | `CHANNEL_DISCARDED` con `actorRole = SYSTEM` | — |

    Cada paso solo actúa si su condición sigue cumpliéndose. Los pasos 1, 2 y 4
    exigen además que su marca esté vacía; los demás dependen de un cambio de
    etapa o de `Post.state`. Repetir el paso no duplica efectos.
*   La conciliación ya no consulta Temporal. La garantía está en
    `getPostsList`, y la terminación de workflows la hace `startWorkflow` de
    Postiz cuando el post pasa a `DRAFT`.

### Página de preview

*   Con el fork activo, los tres endpoints públicos `/public/posts/:id`
    ([public.controller.ts:54-88](../../apps/backend/src/api/routes/public.controller.ts#L54-L88))
    responden `404`.
*   La página `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx`
    pasa a leer desde un endpoint nuevo con sesión, `GET /approvals/preview/:id`,
    que solo devuelve posts de la organización del usuario.
*   Los comentarios se leen desde un endpoint nuevo con sesión,
    `GET /approvals/preview/:id/comments`, que solo devuelve los de la
    organización. Esto reemplaza las lecturas de `/public/posts/:id/comments`
    en `preview.comments.context.tsx` y `comments.components.tsx`.
*   El `previewUrl` con `?share=true` que devuelve la herramienta MCP
    ([integration.schedule.post.ts:290](../../libraries/nestjs-libraries/src/chat/tools/integration.schedule.post.ts#L290))
    sigue funcionando, pero solo para miembros de la organización. En la v1 no
    se cambia la descripción de la herramienta.
*   Los comentarios se crean con el endpoint con sesión que ya existe en
    [posts.controller.ts:85-93](../../apps/backend/src/api/routes/posts.controller.ts#L85-L93).
    En el fork, ese endpoint comprueba además que el post pertenezca a la
    organización.

### Pantallas nuevas y cambios visibles

*   **Bandeja "Pendiente para mí"** (ruta nueva `/approvals`): los lotes de las
    etapas que le tocan a cada rol del usuario. El Monthly Reviewer puede
    seleccionar varios y aprobarlos de una vez. El servidor procesa cada uno por
    separado y devuelve cuáles pasaron y cuáles no, con el motivo.
*   **Briefs** (ruta nueva `/briefs`): el Writer crea y edita briefs. El Creator
    elige "Crear post desde este brief", que abre el editor con el texto base; al
    guardar, el lote queda enlazado al brief.
*   **Panel de aprobación en el editor** (componente nuevo montado en
    [manage.modal.tsx](../../apps/frontend/src/components/new-launch/manage.modal.tsx)):
    muestra la etapa, los botones que el usuario puede usar según su rol y el
    historial del lote.
*   **Botones del editor:** con el fork activo, "Add to calendar", "Schedule" y
    "Post Now" pasan a decir "Guardar". "Guardar" envía `draft` mientras el lote
    no está `APPROVED`, para no registrar `BLOCKED` en cada guardado. El botón "Enviar a revisión" vive en el
    panel de aprobación.
*   **Calendario:** cada post muestra una insignia con su etapa. El filtro existente
    ([filters.tsx](../../apps/frontend/src/components/launches/filters.tsx)) agrega
    "Etapa".
*   **Equipo:** en la configuración del equipo
    ([teams.component.tsx](../../apps/frontend/src/components/settings/teams.component.tsx)),
    un ADMIN marca los roles de trabajo de cada miembro.
*   **Menú superior** ([top.menu.tsx](../../apps/frontend/src/components/layout/top.menu.tsx)):
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
*   Un script nuevo, `scripts/fork/check-schema-additive.mjs` ([archivo 46 del plan](#detailed-implementation-plan)), se ejecuta en CI.
    Hace tres cosas:
    1.  Toma el `schema.prisma` de `upstream/main`.
    2.  Genera con `prisma migrate diff` el SQL necesario para pasar del esquema
        de upstream al del fork. El SQL solo se analiza, nunca se ejecuta.
    3.  Falla si ese SQL contiene `DROP`, `ALTER COLUMN` o `RENAME` sobre una
        tabla de upstream, o si cambia un enum de upstream.
*   `FORK_TOUCHPOINTS.md` (en la raíz; se crea con el [archivo 50 del plan](#detailed-implementation-plan)) lista cada archivo de upstream que el
    fork modifica, con la función tocada y el motivo. En cada actualización
    desde upstream se revisa archivo por archivo.

### Despliegue

*   El fork construye su propia imagen a partir de `Dockerfile.dev` y la publica
    en el registro del equipo. `docker-compose.yaml` del fork apunta a esa
    imagen y no a `ghcr.io/gitroomhq/postiz-app:latest`.
*   Se corrige `var/docker/docker-build.sh`, que hoy apunta a stages de Docker
    (`--target`) que no existen en `Dockerfile.dev`.
*   Los volúmenes de `temporal-postgresql` y `temporal-elasticsearch`, que hoy
    son anónimos, pasan a tener nombre. Así, recrear los contenedores no borra
    los workflows programados. Los de Postgres y Redis de Postiz ya tienen
    nombre.
*   **Variables obligatorias:**
    *   `APPROVALS_ENABLED=true`, en el backend y en el orquestador, porque
        `checkInternalPlug` y `checkPlugs` corren en el orquestador;
    *   `RUN_CRON=true` en el proceso del backend;
    *   `EMAIL_PROVIDER` y sus credenciales, porque los correos a los ADMIN son
        la alerta principal del riesgo aceptado;
    *   las credenciales de las apps de Meta (Facebook e Instagram) y de
        LinkedIn.
*   **Variable recomendada:** `SENTRY_DSN`, para las métricas.
*   `STRIPE_*` se deja vacío.
*   **Puertos de Temporal.** Ni el 7233 (gRPC, sin autenticación) ni el 8080
    (UI) se publican hacia fuera del host. Hoy `docker-compose.yaml:214` y
    `:259` los publican. En el fork se quitan o se limitan a
    `127.0.0.1:7233:7233` y `127.0.0.1:8080:8080`. Quien llegue al 7233 podría
    iniciar un workflow con `postNow` y publicar un borrador sin aprobación.

### Observabilidad

*   **Métricas** con `Sentry.metrics.count`, igual que el `post_created` que ya
    existe:
    *   `approval_blocked`: se pidió `schedule` o `now` y el lote no estaba
        aprobado;
    *   `approval_blocked_at_publish`: `getPostsList` impidió una publicación;
    *   `approval_reset`;
    *   `approval_expired`;
    *   `approval_forced`;
    *   `approval_reconciled`.
*   **Alerta:** un `BLOCKED_AT_PUBLISH` sin `fingerprint_drift`, o un
    `RECONCILED` sin `reason: 'startup'`, indica un camino que intentó publicar
    sin aprobación. No publicó, pero hay que investigarlo. La alerta principal
    es el correo directo a los ADMIN, que no depende de Sentry.
*   **Logs:** cada acción del flujo escribe una línea con `approvalId`,
    `batchId`, la acción y el actor.

### Instalación inicial

El documento de concepto pedía un script que, en el primer arranque, regresara a
revisión los posts en `QUEUE` sin aprobación. No hace falta un script aparte. La
conciliación que hace el backend al arrancar ya los regresa a `DRAFT` (punto 5
de la tarea de mantenimiento), y `approvalSweepWorkflow` lo repite cada 15
minutos.

--------------------------------------------------------------------------------

## Risks & Mitigations

La regla central se comprueba en `getPostsList`, justo antes de publicar. Por
eso ya no hay un riesgo aceptado de "workflow dormido": un camino de upstream
que no está en la tabla, una carrera entre una aprobación y una edición, o un
workflow iniciado a mano terminan en `ERROR 'No Post'` sin publicar.

| Riesgo | Impacto | Mitigación | Señal | Riesgo residual |
|---|---|---|---|---|
| Un camino nuevo de upstream escribe `QUEUE` sin pasar por el punto de control. | El post no se publica: termina en `ERROR 'No Post'`. | `getPostsList` comprueba la regla. La conciliación lo devuelve a `DRAFT` (paso 5a). | `BLOCKED_AT_PUBLISH` con correo a los ADMIN. | El post sale tarde o no sale, pero nunca sale sin aprobación. Se acepta. |
| Upstream cambia `getPostsList` o deja de llamarla después de dormir. | Se perdería la garantía. | `post.activity.ts` está en `FORK_TOUCHPOINTS.md`. El procedimiento de actualización comprueba que la versión vigente de `postWorkflow` llama a `getPostsList` después del `sleep`. Una prueba de `getPostsList` con el fork activo devuelve `[]` para un lote no aprobado. | CI en rojo. | Depende de que se siga el procedimiento al actualizar. Se acepta. |
| Una reescritura de Postiz cambia la huella de un lote aprobado. | El post no se publica a su hora. | Reglas de normalización de la huella. El paso 5a lo distingue con `reason: 'fingerprint_drift'` y avisa a los Monthly Reviewer para reaprobar. | `BLOCKED_AT_PUBLISH` con `fingerprint_drift`. | Una reescritura no prevista atrasa la publicación. Se acepta, porque queda señalada. |
| Una aprobación y una edición llegan al mismo tiempo. | Podría quedar en `QUEUE` un post con texto no aprobado. | El campo `version` con `transition` en el repositorio. Si la edición se cuela, `getPostsList` la bloquea. | `409`, o `BLOCKED_AT_PUBLISH`. | Ninguno conocido. |
| Acceso directo a Temporal. | Un workflow iniciado a mano con `postNow`. | `getPostsList` lo bloquea igual. Además, los puertos 7233 y 8080 no se publican fuera del host. | `BLOCKED_AT_PUBLISH`. | Quien tenga acceso al host puede llegar a Temporal y a la base. Se acepta. |
| El bucle de `createPost` falla a la mitad. | Unos canales con contenido nuevo y otros con el viejo. | Todo se guardó como `draft`, y el `finally` llama a `afterSave`, que reinicia si la huella cambió. | Error en los logs. | El lote queda en `DRAFT` (en pausa o en revisión). El Creator lo revisa. Se acepta. |
| El equipo se queda sin aprobadores. | Nada se publica. | Dotación mínima recomendada: 2 Reviewer y 2 Monthly Reviewer, con una advertencia en la pantalla de Equipo. Un ADMIN puede reasignar el rol (CUJ 7). | Lotes en `AWAITING_FINAL` vencidos. | Depende de que un ADMIN reasigne. Se acepta. |
| Un Reviewer corrige una coma durante la revisión. | Queda como autor y ya no puede aprobar ese lote. | Es la regla de autoría a propósito. Con la dotación mínima queda otro Reviewer. | — | Más trabajo para el segundo Reviewer. Se acepta. |
| Se reaprueba un lote que ya tiene canales publicados. | Esos canales se publicarían dos veces. | Un post raíz en `PUBLISHED` nunca vuelve a `QUEUE`, y `republish: true` se rechaza sobre él. | Ninguna (está bloqueado). | Ninguno. |
| Una persona con varios roles controla la cadena entera. | Puede publicar sin nadie más. | Nadie aprueba ni fuerza un lote del que es autor. Los roles y cada `FORCED` quedan en el historial y avisan a los ADMIN. | `ROLE_ASSIGNED`, `FORCED`. | Un ADMIN puede asignarse roles. Queda registrado. Se acepta. |
| Suplantación de superadmin. | Una persona aprueba dos etapas con dos nombres. | `ApprovalsController` rechaza las acciones del flujo cuando `user.isSuperAdmin` y hay `impersonate`. | `403` en los logs. | Un superadmin puede suplantar para editar; esa edición excluye a la persona suplantada. Se acepta. |
| Edición con API key, sin actor. | Quien tiene la API key podría editar de forma anónima y después aprobar. | La edición queda como `CONTENT_EDITED` sin actor y reinicia la revisión. | `CONTENT_EDITED` con `surface = API`. | No se puede excluir a quien edita con API key. Se acepta: la API key la guarda un ADMIN. |
| Los avisos no llegan a nadie. | Un lote vence sin que nadie lo vea. | Avisos de equipo con tipo `'info'`, correos directos a cada rol, y advertencia de `hasEmailProvider()` al arrancar. | Advertencia en el log. | Sin `EMAIL_PROVIDER` solo quedan los avisos internos. Por eso es obligatoria. |
| MCP crea un lote por canal. | Se aprueba por separado cada canal de un mismo contenido. | Límite documentado de la v1. | — | Más clics. Se acepta. |
| Upstream cambia un archivo tocado por el fork. | Conflictos al actualizar. | `FORK_TOUCHPOINTS.md`, el chequeo de esquema en CI y `pnpm test:fork`. | CI en rojo. | Costo de mantenimiento en cada actualización. |
| Se filtra texto no aprobado por el preview. | Gente de fuera lee borradores. | El preview y sus comentarios exigen sesión, y los endpoints públicos responden `404`. | — | Un miembro puede copiar el texto fuera. No se controla. |
| Escala de la conciliación. | Cada 15 minutos se calcula la huella de los posts raíz en `QUEUE` y en `ERROR`. Para 4 a 10 personas, decenas de posts. | Si pasa de 500, procesar en páginas de 100. | Duración del paso en los logs. | Ninguno al volumen previsto. |
| Cumplimiento de la AGPL. | Usar el fork por la red sin ofrecer el código podría incumplir la licencia. | El repo del fork está disponible para sus usuarios; revisión legal antes de abrir la plataforma fuera del equipo (ver [Open Questions](#open-questions)). | — | La interpretación no tiene revisión legal. |

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
*   **Motivo del rechazo**: no cumple la meta 1.

#### Alternativa B: Notion, Trello o una hoja de cálculo junto a Postiz sin cambios

El equipo lleva el flujo en una herramienta externa y solo programa en Postiz lo
que se aprobó ahí.

*   **A favor**: no requiere desarrollo.
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
    *   Si upstream agrega estados propios más adelante, chocarían con los del
        fork.
*   **Motivo del rechazo**: obliga a cambiar unas 35 comparaciones y deja posts
    fuera de las listas, de la API y de MCP. `State` queda solo para la
    publicación, y la etapa vive en `PostApproval`.

#### Alternativa E: columnas de aprobación en la tabla `Post`

*   **A favor**: no hay que hacer joins.
*   **En contra**: `Post` está en el centro de `posts.repository.ts` y
    `posts.service.ts`, los archivos más grandes del dominio. La fila se
    reescribe en cada guardado y el editor rota el `group`. Tampoco queda
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

#### Alternativa I: solo el punto de control al guardar, sin tocar el orquestador

Era la decisión anterior. La regla se aplicaba solo en `PostsService` antes de
escribir, y el orquestador no se tocaba.

*   **A favor**: el orquestador queda fuera de `FORK_TOUCHPOINTS.md`.
*   **En contra**: el workflow de publicación revisa el estado solo antes de
    dormir, así que la garantía dependía de encontrar cada camino de Postiz que
    escribe en `Post` y de terminar a tiempo cada workflow dormido. Cuatro
    rondas de revisión encontraron caminos nuevos en cada pasada
    (`changeDate('update')`, `updateMedia`, la suplantación, el puerto 7233 con
    `postNow`). Para cubrirlos hicieron falta seis mecanismos de concurrencia,
    una terminación estricta con `503`, un margen de 2 minutos y un riesgo
    aceptado de hasta 15 minutos.
*   **Motivo del rechazo**: la comprobación en `getPostsList` cuesta un archivo
    más de upstream y cierra todos esos caminos a la vez, incluidos los que
    upstream agregue después.

#### Alternativa I2: comprobar en `postSocialInternal` en vez de `getPostsList`

*   **A favor**: la comprobación queda justo al lado de la llamada a la red.
*   **En contra**: un post bloqueado lanzaría `BadBody` y terminaría en `ERROR`
    con el aviso normal de error de Postiz. Además, habría que repetirla en
    `postComment` para los hilos. `getPostsList` corre una vez, antes de todo, y
    ya tiene un precedente de devolver `[]` (la suscripción de Stripe).
*   **Motivo del rechazo**: `getPostsList` es más simple y no dispara avisos de
    error.

#### Alternativa J: un workflow nuevo (V113) que vuelva a comprobar al despertar

*   **A favor**: el post bloqueado queda "vencido" o "bloqueado" en vez de
    `ERROR`, y no se envía el aviso de error de Postiz.
*   **En contra**: son unas 700 líneas copiadas de V112. La siguiente versión de
    upstream choca con el nombre, y cada arreglo que upstream haga en V112 hay
    que portarlo a mano. El nombre del workflow aparece escrito en dos lugares
    (`posts.service.ts:972` y `post.activity.ts:121`).
*   **Motivo del rechazo**: obliga a mantener una copia de unas 700 líneas y a
    portar a mano cada cambio de upstream. La comprobación en `getPostsList`
    logra lo mismo cambiando unas pocas líneas.

#### Alternativa K: un middleware de Prisma que bloquee las escrituras de `QUEUE`

*   **A favor**: bloquearía también las escrituras de `QUEUE` de los caminos
    nuevos de upstream. El orquestador no se ve afectado, porque solo escribe
    `ERROR` y `PUBLISHED` (`post.activity.ts:494-495`).
*   **En contra**:
    *   En Prisma 6.5, `$use` está obsoleto. Habría que usar `$extends` sobre el
        cliente compartido, lo que cambia el tipo del cliente en todo el repo.
    *   No cubre un workflow que ya estaba dormido cuando el post salió de
        `QUEUE`. `getPostsList` sí lo cubre.
    *   La regla queda fuera del código de servicio, donde la busca quien lee.
*   **Motivo del rechazo**: el cambio de tipo del cliente toca todo el repo, y
    `getPostsList` ya da la garantía. Queda como opción de defensa en
    profundidad, solo para registrar y alertar sin bloquear (ver Future
    Improvements).

#### Alternativa L: llevar la aprobación en señales de Temporal

*   **A favor**: el workflow sabría directamente si está aprobado.
*   **En contra**: Postiz termina y reinicia el workflow en cada guardado, y las
    señales se pierden con él.
*   **Motivo del rechazo**: la base de datos tiene que ser la fuente de verdad.

### Unidad de aprobación y reinicio

#### Alternativa M: usar `group` como llave de la aprobación

*   **A favor**: es el campo que usa el calendario.
*   **En contra**: el editor le asigna un `group` nuevo en cada guardado, y
    `group` cubre un solo canal.
*   **Motivo del rechazo**: la llave cambiaría todo el tiempo. Se usa `batchId`,
    que el repositorio mantiene igual entre guardados (`posts.repository.ts:626-649`).

#### Alternativa N: aprobación por canal

*   **A favor**: un error en un canal no frena a los demás.
*   **En contra**: multiplica los clics del Monthly Reviewer, que tendría que
    aprobar lo mismo una vez por red. Además, un lote podría quedar con unos
    canales aprobados y otros no, y su etapa no cabría en un solo valor de
    `PostApproval.stage`.
*   **Motivo del rechazo**: los clics del Monthly Reviewer se multiplicarían por
    el número de redes, y una etapa mixta no cabe en `PostApproval.stage`. Como
    consecuencia de aprobar por lote, editar un solo canal reinicia el lote
    entero.

#### Alternativa O: aprobar el calendario del mes en un solo paso

*   **A favor**: el Monthly Reviewer interviene una sola vez al mes.
*   **En contra**: los posts nuevos y los cambios a mitad de mes no pasarían por
    el Monthly Reviewer.
*   **Motivo del rechazo**: no cumple la meta 1. La bandeja con aprobación de
    varios posts a la vez resuelve la carga de trabajo.

#### Alternativa P: reiniciar todo desde el principio con cualquier cambio

*   **A favor**: es la regla más estricta y no necesita distinguir tipos de
    cambio.
*   **En contra**: corregir una letra o arrastrar un post en el calendario
    borraría todas las aprobaciones.
*   **Motivo del rechazo**: mover una fecha no cambia lo que se publica, así que
    reiniciar por eso obligaría a volver a aprobar contenido idéntico.

#### Alternativa Q: usar `updatedAt` en lugar de una huella

*   **A favor**: el campo ya existe.
*   **En contra**: cambia con cualquier actualización, incluidos los cambios de
    estado, de media y de `releaseURL` que hace el sistema.
*   **Motivo del rechazo**: reiniciaría aprobaciones sin que nadie haya cambiado
    el contenido.

### Otros caminos, redes y datos

#### Alternativa R: apagar del todo la API pública, el SDK y MCP

*   **A favor**: elimina tres caminos de entrada y la necesidad de cubrirlos en
    el punto de control.
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
    tocar lo de upstream. La vuelta atrás de las tablas del fork se hace a mano,
    con los pasos de `docs/fork/runbook.md`, que se crea con el [archivo 51 del plan](#detailed-implementation-plan).

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

### Decisiones secundarias

#### Alternativa X: exigir siempre un brief del Writer para enviar a revisión

*   **A favor**: el Writer siempre define el tema.
*   **En contra**: un post urgente queda bloqueado si el Writer no está.
*   **Motivo del rechazo**: lo decidió la persona dueña del diseño. Se usa el
    brief rápido del Creator, que queda marcado.

#### Alternativa Y: permitir solo lectura durante la suplantación, en vez de rechazar todo

*   **A favor**: un superadmin puede revisar cómo ve el flujo otra persona.
*   **En contra**: es lo que ya hace la regla, porque solo se rechazan las rutas
    `POST` y `PUT`. La alternativa real sería registrar al superadmin como
    actor, pero el middleware reemplaza `req.user` y el actor real se pierde.
*   **Motivo del rechazo**: registrar al actor real obliga a cambiar
    `auth.middleware.ts`. Rechazar las acciones no.

#### Alternativa Z: plugs y posts repetidos con texto aprobado

*   **A favor**: el equipo conserva esas funciones.
*   **En contra**: el texto de los plugs vive en los ajustes de la integración o
    del post, y lo ejecuta el orquestador después de publicar. Habría que
    incluirlo en la huella y aprobar cada repetición.
*   **Motivo del rechazo**: es el mismo trabajo que aprobar un post más, sin
    pantalla para hacerlo. Se apagan en la v1.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Seguridad**
    *   Las acciones del flujo solo se aceptan con una sesión web y se validan en
        la capa de servicio.
    *   El preview y sus comentarios exigen sesión.
    *   El historial no se edita ni se borra desde la aplicación.
    *   `STRIPE_*` queda vacío y la UI de Temporal no se expone a internet.
    *   Licencia AGPL-3.0: ver [Open Questions](#open-questions).
*   **Rendimiento**
    *   Después de cada guardado, el punto de control lee `PostApproval`, las
        filas del lote y los `id` de `Media`, y calcula un hash SHA-256 por
        canal.
    *   Antes de cada publicación, `getPostsList` hace lo mismo para un solo
        canal.
    *   Cada 15 minutos, la tarea de mantenimiento hace cinco consultas a
        `PostApproval`, con los índices `(organizationId, stage,
        earliestPublishDate)` y `(verifyDueAt)`, y calcula la huella de los posts
        raíz en `QUEUE` y en `ERROR 'No Post'`. Ya no consulta Temporal.
    *   Presupuesto: el punto de control no debe sumar más de 50 ms a un
        guardado de un lote de 3 canales, ni más de 20 ms a `getPostsList`. Se
        mide en la prueba de punta a punta.
*   **Despliegue y vuelta atrás**
    *   `APPROVALS_ENABLED=false` devuelve a Postiz su comportamiento de origen
        sin borrar datos.
    *   Para quitar las tablas del fork se siguen los pasos de
        `docs/fork/runbook.md` (se crea con el [archivo 51 del plan](#detailed-implementation-plan)):
        1.  Hacer un respaldo de la base.
        2.  Poner `APPROVALS_ENABLED=false`.
        3.  Quitar el bloque `FORK` de `schema.prisma` y las relaciones inversas
            en `Organization`, `User` y `Comments`.
        4.  Ejecutar `prisma db push --accept-data-loss` **a mano y antes de
            reiniciar**. Si no, el `db push` que corre al arrancar se detiene
            ante el borrado de tablas y la aplicación no arranca.

## Future Improvements

*   **Media fuera de la biblioteca.** `updateMedia` reescribe `image.path` en
    todas las redes cuando el normalizador reemplaza un archivo, y en TikTok
    también al convertir a JPEG
    ([posts.service.ts:506-611](../../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts#L506-L611)).
    La huella ya ignora ese cambio para los archivos que están en la biblioteca;
    si no, `getPostsList` bloquearía la publicación con `fingerprint_drift`.
    Si se agregan redes con conversión, hay que comprobar que también los
    archivos sin `id` de biblioteca conserven su `path`.
*   **Más redes.** El punto de control ya las cubre. Falta configurar la app,
    las credenciales y las pruebas de cada red.
*   **Alerta en Prisma.** Una extensión `$extends` que solo registre, sin
    bloquear, cualquier escritura de `QUEUE` que no venga del punto de control
    (alternativa K como defensa en profundidad).
*   **Aprobar desde la API con OAuth.** Hoy solo se aprueba desde la web. Un
    token OAuth sí identifica a la persona (`oauthUserId`), así que se podría
    permitir aprobar con ese tipo de token.
*   **Informe mensual de analíticas** para el Monthly Reviewer, construido sobre
    las analíticas que Postiz ya trae.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Reglas que siguen todos los archivos, tomadas de [CLAUDE.md](../../CLAUDE.md):

*   **Capas del backend:** DTO → Controller → Service → Repository, sin atajos.
    Las transacciones viven en el repositorio, con `PrismaTransaction`, como
    en `clipping.repository.ts`.
*   **Base de datos:** solo Prisma, nunca SQL a mano.
*   **Frontend:** un hook de SWR por recurso, con `useFetch`; componentes propios
    con Tailwind 3 y sin colores `--color-custom*`.
*   **Orquestador:** no se modifica ningún workflow existente; se agrega uno
    nuevo (`approvalSweepWorkflow`). De las actividades existentes solo cambia
    el **cuerpo** de `getPostsList`, no sus parámetros.
*   **Pruebas:** se usa un Postgres real de prueba con `prisma db push` (servicio
    `postgres:17` en CI y `docker compose` en local), y el `PostsRepository`
    real. Temporal se simula con `jest-mock-extended`, que ya está en
    `devDependencies`.
*   **Interruptor:** en el backend y el orquestador se usa
    `ApprovalGateService.enabled()` (`APPROVALS_ENABLED === 'true'`). En el
    frontend se usa `approvalsEnabled` del contexto de variables, salvo en
    Server Components, que leen `process.env.APPROVALS_ENABLED`.

Cada archivo de upstream que se modifica entra en `FORK_TOUCHPOINTS.md`. Esos
archivos están marcados como **(upstream)**.

### Fases

Cada fase deja el repo compilable y con pruebas en verde. Al final de cada una
se ejecutan `pnpm build` y `pnpm test:fork`.

| Fase | Archivos | Resultado |
|---|---|---|
| 1. Base | 1, 2, 2b, 10, 11, 48, 49 | Esquema aplicado con `prisma db push` sobre una base vacía; repositorio y DTOs compilan; `pnpm test:fork` termina con código 0 (`passWithNoTests`); `pnpm lint:fork` termina con código 0. |
| 2. Punto de control | 2c, 3, 4, 8 (parte 2), 9, 9b, 55b, 52, 52b, 52c, 55, 55c | Las pruebas 52, 52b, 52c, 55 y 55c pasan. Con `APPROVALS_ENABLED=false`, la prueba 55 confirma el comportamiento de upstream. |
| 3. Flujo y API | 5, 6, 8 (parte 3), 13 a 18, 53, 53b, 53c | Las pruebas 53, 53b y 53c pasan; cada ruta de `approvals.controller.ts` responde según la tabla de transiciones. |
| 4. Mantenimiento | 7, 8 (parte 4), 12, 19 a 22, 54 | La prueba 54 pasa; en local, `approvalSweepWorkflow` aparece en Temporal como `Running`. |
| 5. Frontend | 23 a 42 | Con `APPROVALS_ENABLED=true`, `/approvals`, `/briefs` y el panel del editor se muestran; `/p/<id>` sin sesión redirige al login. |
| 6. Infraestructura y CI | 43 a 47, 50, 51 | `fork-checks.yml` termina sin errores; los puertos 7233 y 8080 no responden desde fuera del host. |

El umbral de cobertura de cada archivo (archivo 48) se activa en la fase en que
ese archivo se crea.

### Target Files to Create/Modify

#### A. Esquema

##### 1. `libraries/nestjs-libraries/src/database/prisma/schema.prisma` (Modify, upstream)

*   **Tipo / alcance**: esquema de Prisma.
*   **Cambios propuestos**: al final del archivo se agrega este bloque. Los ids
    son `uuid`, como en `UserOrganization`.

    ```prisma
    // ==== FORK: approvals ====
    enum WorkflowRole { TECHNICAL_WRITER CREATOR REVIEWER MONTHLY_REVIEWER }
    enum ActorRole { TECHNICAL_WRITER CREATOR REVIEWER MONTHLY_REVIEWER MEMBER SYSTEM }
    enum ApprovalStage { IN_PRODUCTION IN_REVIEW AWAITING_FINAL CHANGES_REQUESTED APPROVED PUBLISHED VERIFIED VERIFICATION_PROBLEM }
    enum ApprovalAction { CREATED LINKED_BRIEF SUBMITTED REVIEW_APPROVED FINAL_APPROVED REJECTED CONTENT_EDITED RESET_BY_EDIT DATE_CHANGED EXPIRED FORCED PUBLISHED VERIFIED VERIFICATION_PROBLEM BLOCKED BLOCKED_AT_PUBLISH RECONCILED CHANNEL_DISCARDED ROLE_ASSIGNED ROLE_REMOVED }
    enum BriefStatus { OPEN IN_PRODUCTION DONE CANCELLED }

    model WorkflowRoleAssignment {
      id             String       @id @default(uuid())
      organizationId String
      organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
      userId         String
      user           User         @relation("WorkflowRoleUser", fields: [userId], references: [id], onDelete: Cascade)
      role           WorkflowRole
      createdById    String
      createdBy      User         @relation("WorkflowRoleCreatedBy", fields: [createdById], references: [id])
      createdAt      DateTime     @default(now())

      @@unique([organizationId, userId, role])
      @@index([organizationId, role])
    }

    model ContentBrief {
      id                     String        @id @default(uuid())
      organizationId         String
      organization           Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
      topic                  String
      baseCopy               String?
      targetDate             DateTime?
      assignedCreatorId      String?
      assignedCreator        User?         @relation("BriefAssignedCreator", fields: [assignedCreatorId], references: [id], onDelete: SetNull)
      status                 BriefStatus   @default(OPEN)
      quickBrief             Boolean       @default(false)
      correctionOfApprovalId String?
      correctionOf           PostApproval? @relation("BriefCorrectionOf", fields: [correctionOfApprovalId], references: [id], onDelete: SetNull)
      approvals              PostApproval[] @relation("ApprovalBrief")
      createdById            String
      createdBy              User          @relation("BriefCreatedBy", fields: [createdById], references: [id])
      createdAt              DateTime      @default(now())
      updatedAt              DateTime      @updatedAt
      deletedAt              DateTime?

      @@index([organizationId, status])
    }

    model PostApproval {
      id                   String              @id @default(uuid())
      organizationId       String
      organization         Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
      batchId              String              @unique
      briefId              String?
      brief                ContentBrief?       @relation("ApprovalBrief", fields: [briefId], references: [id], onDelete: SetNull)
      stage                ApprovalStage       @default(IN_PRODUCTION)
      version              Int                 @default(0)
      approvedFingerprints Json?
      earliestPublishDate  DateTime
      forced               Boolean             @default(false)
      warned48At           DateTime?
      warned24At           DateTime?
      warnedExpiredAt      DateTime?
      verifyDueAt          DateTime?
      warnedVerifyAt       DateTime?
      verifiedAt           DateTime?
      verifiedById         String?
      verifiedBy           User?               @relation("ApprovalVerifiedBy", fields: [verifiedById], references: [id], onDelete: SetNull)
      corrections          ContentBrief[]      @relation("BriefCorrectionOf")
      events               PostApprovalEvent[]
      createdAt            DateTime            @default(now())
      updatedAt            DateTime            @updatedAt

      @@index([organizationId, stage, earliestPublishDate])
      @@index([verifyDueAt])
    }

    model PostApprovalEvent {
      id             String          @id @default(uuid())
      organizationId String
      organization   Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
      approvalId     String?
      approval       PostApproval?   @relation(fields: [approvalId], references: [id], onDelete: Cascade)
      actorUserId    String?
      actor          User?           @relation("EventActor", fields: [actorUserId], references: [id], onDelete: SetNull)
      actorRole      ActorRole
      action         ApprovalAction
      surface        CreationMethod  @default(UNKNOWN)
      fingerprints   Json?
      snapshot       Json?
      commentId      String?
      comment        Comments?       @relation(fields: [commentId], references: [id], onDelete: SetNull)
      reason         String?
      targetUserId   String?
      targetUser     User?           @relation("EventTarget", fields: [targetUserId], references: [id], onDelete: SetNull)
      targetRole     WorkflowRole?
      createdAt      DateTime        @default(now())

      @@index([approvalId, createdAt])
      @@index([organizationId, action, createdAt])
    }
    // ==== END FORK ====
    ```

    Campos inversos que se agregan a modelos de upstream, cada uno con el
    comentario `// FORK`:

    *   `Organization`: `workflowRoles WorkflowRoleAssignment[]`,
        `contentBriefs ContentBrief[]`, `postApprovals PostApproval[]` y
        `postApprovalEvents PostApprovalEvent[]`.
    *   `User`: `workflowRoles WorkflowRoleAssignment[] @relation("WorkflowRoleUser")`,
        `workflowRolesGranted WorkflowRoleAssignment[] @relation("WorkflowRoleCreatedBy")`,
        `briefsAssigned ContentBrief[] @relation("BriefAssignedCreator")`,
        `briefsCreated ContentBrief[] @relation("BriefCreatedBy")`,
        `approvalsVerified PostApproval[] @relation("ApprovalVerifiedBy")`,
        `approvalEventsActed PostApprovalEvent[] @relation("EventActor")` y
        `approvalEventsTargeted PostApprovalEvent[] @relation("EventTarget")`.
    *   `Comments`: `approvalEvents PostApprovalEvent[]`.

    `PostApproval.batchId` no tiene clave foránea hacia `Post`, porque
    `Post.batchId` no es único. `snapshot` se llena en `SUBMITTED`,
    `REVIEW_APPROVED`, `FINAL_APPROVED` y `FORCED` con el texto y la media de
    cada canal.
*   **Por qué**: guarda el estado del flujo sin agregar columnas ni cambiar
    enums de upstream. En `Organization`, `User` y `Comments` solo agrega campos
    de relación inversa, que no crean columnas.

#### B. Backend compartido (librería)

##### 2. `libraries/nestjs-libraries/src/database/prisma/approvals/approvals.repository.ts` (Create)

*   **Tipo / alcance**: repositorio de NestJS. Inyecta `PrismaRepository` para
    `postApproval`, `postApprovalEvent`, `workflowRoleAssignment`,
    `contentBrief`, `post`, `media` y `userOrganization`, y `PrismaTransaction`.
*   **Cambios propuestos**: un método por consulta. Todos filtran por
    `organizationId`, y los que leen `User` usan `select` con solo `id`,
    `email`, `name` y `lastName`. El nombre visible es
    `[name, lastName].join(' ') || email`, como en `posts.service.ts:1622-1626`.
    *   Los métodos que reciben `approvalId` también reciben `orgId` y
        filtran por él. Para listar valores distintos se usa `groupBy`, no
        `distinct`: en Prisma 6.5 sin `nativeDistinct`, `distinct` carga todas
        las filas y quita los duplicados en memoria.
    *   **Aprobaciones y eventos:**
        *   `getApprovalByBatch(orgId, batchId)` y `getApprovalByPost(orgId, postId)`.
        *   `createApproval(orgId, batchId, earliestPublishDate, event)`: crea la
            fila y el evento `CREATED` en una transacción.
        *   `transition(orgId, id, expectedVersion, data, events[]): Promise<boolean>`:
            dentro de `this._transaction.model.$transaction(async tx => …)` hace
            `updateMany({ where: { id, organizationId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } })`.
            Si `count === 0`, devuelve `false` sin crear eventos. Si no, crea
            los eventos y devuelve `true`.
        *   `insertEvent(event)`, para eventos que no cambian la fila.
        *   `lastEventWithFingerprints(approvalId)`: el último evento entre
            `CREATED`, `CONTENT_EDITED`, `SUBMITTED`, `RESET_BY_EDIT` y
            `REVIEW_APPROVED`.
        *   `authorIds(approvalId)`: los `actorUserId` distintos de `CREATED`,
            `SUBMITTED` y `CONTENT_EDITED`.
        *   `lastActorOf(approvalId, action)`.
        *   `history(approvalId)`: los eventos ordenados por `createdAt`.
        *   `previousEventOf(approvalId, action, before)`: el evento anterior de
            esa acción, para el límite de avisos de 15 minutos.
    *   **Lote y posts:**
        *   `getBatchRootPosts(orgId, batchId)`: posts raíz no borrados del
            lote, con `id`, `group`, `integrationId`, `state`, `error`,
            `publishDate`, `content`, `image`, `delay`, `settings` y sus hijos
            (mismos campos), ordenados.
        *   `getBatchIdsForPosts(orgId, postIds[])`.
        *   `getRootPostByGroup(orgId, group)`: `id`, `state`, `batchId` e
            `integrationId` del post raíz de un `group`.
        *   `setRootPostsDraft(orgId, postIds[])`: `state = DRAFT` en esos posts
            raíz y sus hijos. Solo lo usa `PostsService` cuando procesa `toDraft`
            (ver archivo 9), justo antes de `startWorkflow(DRAFT)`.
        *   `updateEarliestPublishDate(approvalId)`: la recalcula desde la base.
            Solo si el valor nuevo es distinto del guardado borra las marcas
            cuyo umbral ya no aplica: `warnedExpiredAt` si la fecha nueva es
            futura, `warned24At` si está a más de 24 h y `warned48At` si está a
            más de 48 h. Una edición que no mueve la fecha no reenvía avisos.
        *   `findExistingMediaIds(orgId, ids[]): Promise<Set<string>>`:
            `findMany` sobre `media` con `select: { id: true }` y **sin** filtro
            por `deletedAt`.
    *   **Bandeja y calendario:**
        *   `listInbox(orgId, stages[])`: aprobaciones con brief, posts raíz
            (`id`, `group`, `integrationId`, `publishDate`, `state`) y
            `version`, solo de lotes con posts no borrados.
        *   `getStagesForPosts(orgId, postIds[])` →
            `{ [postId]: { batchId, stage, version, expired } }`.
    *   **Roles y equipo:**
        *   `getRoles(orgId, userId)`, `listRoles(orgId)` y
            `listUsersWithRole(orgId, role)`. Excluyen a los miembros con
            `UserOrganization.disabled = true`.
        *   `listOrgAdmins(orgId)`: `id` y `email` de los ADMIN y SUPERADMIN no
            deshabilitados.
        *   `isMember(orgId, userId)`.
        *   `setRoles(orgId, userId, roles[], byUserId)`: borra y crea filas, e
            inserta un evento `ROLE_ASSIGNED` o `ROLE_REMOVED` por cada cambio,
            en una sola transacción.
    *   **Briefs:** `createBrief`, `updateBrief`, `listBriefs(orgId, status?)` y
        `getBrief`.
    *   **Tarea de mantenimiento:**
        *   `listOrgIdsToSweep()`: la unión de los `organizationId` con
            `PostApproval` y de los que tienen posts raíz no borrados en `QUEUE`
            o `ERROR`. Así entran también las organizaciones cuyos posts se
            crearon con `APPROVALS_ENABLED=false`.
        *   `findExpired(orgId, now)`, `findWarnable(orgId, now, hours)`,
            `findPublishedCandidates(orgId)` y `findVerificationOverdue(orgId, now)`.
        *   `findBlockedAtPublish(orgId)`: posts raíz en `ERROR` con
            `error = 'No Post'`.
        *   `findQueueRoots(orgId)`: posts raíz en `QUEUE`.
        *   `findErrorRootsInUnapproved(orgId)`.
        *   `findBatchesWithoutApproval(orgId)`: solo lotes con al menos un
            post raíz no borrado que no esté en `PUBLISHED`. El historial ya
            publicado no recibe `PostApproval`.
*   **Por qué**: es el único punto de acceso a las tablas del fork.

##### 2b. `libraries/helpers/src/utils/is.allowed.media.path.ts` (Create)

*   **Tipo / alcance**: función exportada.
*   **Cambios propuestos**: se mueve aquí el cuerpo de
    `PostsService.isAllowedMediaPath` (`posts.service.ts:624-638`), sin cambios.
*   **Por qué**: la huella necesita la misma regla, y el punto de control no
    puede depender de `PostsService`.

##### 2c. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.notify.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `NotificationService` y
    `ApprovalsRepository`.
*   **Cambios propuestos**:
    *   `notifyRole(orgId, role, template, data)`: crea un aviso interno con
        `inAppNotification(orgId, subject, text, false)` y envía
        `sendEmail(to, subject, html)` a cada persona del rol.
    *   `notifyUser(orgId, userId, template, data)`.
    *   `notifyTeam(orgId, template, data)`: llama a
        `inAppNotification(orgId, subject, text, true, false, 'info')`.
    *   `notifyAdmins(orgId, template, data)`: envía `sendEmail` a cada persona
        de `listOrgAdmins`.
    *   **Límite de avisos:** `notifyRole` no envía el aviso de `RESET_BY_EDIT`
        si `previousEventOf(approvalId, 'RESET_BY_EDIT', now)` tiene `createdAt`
        de hace menos de 15 minutos. Es la única definición de este límite.
    *   **Datos de las plantillas:** `{tema}` es el `topic` del brief, o "(sin
        tema)". La URL es `${FRONTEND_URL}/p/${rootId}`, con el primer post raíz
        del lote por `createdAt`.
    *   **Plantillas.** `text` es texto plano con la URL del post, y `html` es
        el mismo contenido con un enlace. Nunca llevan el texto del post ni el
        de un comentario.

        | Plantilla | Asunto | Destinatarios |
        |---|---|---|
        | `SUBMITTED` | "Post para revisar: {tema}" | Reviewer |
        | `REVIEW_APPROVED` | "Post para aprobación final: {tema}" | Monthly Reviewer |
        | `REJECTED` | "Cambios pedidos: {tema}" | Quien hizo el último `SUBMITTED` |
        | `RESET_BY_EDIT` | "Post editado, vuelve a revisión: {tema}" | Reviewer |
        | `WARN_48H` / `WARN_24H` | "Vence en 48 h / 24 h: {tema}" | Rol de la etapa actual |
        | `EXPIRED` | "Venció sin aprobación: {tema}" | Todo el equipo |
        | `PUBLISHED` | "Publicado, falta verificar: {tema}" | Technical Writer |
        | `VERIFY_OVERDUE` | "Verificación pendiente: {tema}" | Technical Writer y Monthly Reviewer |
        | `FORCED` | "Publicación forzada: {tema}" | Todo el equipo y, por correo, los ADMIN |
        | `BLOCKED_AT_PUBLISH` | "Se impidió publicar sin aprobación: {tema}" | ADMIN (o Monthly Reviewer si es `fingerprint_drift`) |
        | `RECONCILED` | "Post sin aprobación desprogramado: {tema}" | ADMIN |
        | `VERIFICATION_PROBLEM` | "Problema en un post publicado: {tema}" | Todo el equipo |

    *   `NotificationService.hasEmailProvider()` se consulta al arrancar el
        módulo, y si devuelve `false` se escribe una advertencia en el log.
*   **Por qué**: el punto de control, `ApprovalService` y la tarea de
    mantenimiento envían avisos. Así no se duplica la lógica y no se forma un
    ciclo de dependencias.

##### 3. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.policy.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository`.
*   **Cambios propuestos**:
    *   `assertCan(actorUserId, orgId, action, approval)`. Lanza
        `ForbiddenException` con un mensaje que nombra la regla incumplida:
        1.  El actor tiene alguno de los roles que admite la acción: `SUBMITTED`
            → Creator; `REVIEW_APPROVED` → Reviewer; `REJECTED` → Reviewer o
            Monthly Reviewer; `FINAL_APPROVED` y `FORCED` → Monthly Reviewer;
            `LINKED_BRIEF` → Creator o Technical Writer; `VERIFIED` y
            `VERIFICATION_PROBLEM` → Technical Writer.
        2.  En `REVIEW_APPROVED`, `FINAL_APPROVED` y `FORCED`, el actor no es
            autor del lote (definición en el [Glosario](#glosario), con
            `authorIds`).
        3.  En `FINAL_APPROVED`, y en `FORCED` desde `AWAITING_FINAL`, el
            actor tampoco hizo el último `REVIEW_APPROVED`.
    *   `actorRoleFor(orgId, userId, action)`. Para las acciones del flujo,
        devuelve el primero de los roles admitidos que tenga la persona, en el
        orden de la lista anterior. Para `CREATED` y `CONTENT_EDITED`,
        `CREATOR` si la persona lo tiene, y si no `MEMBER`. Sin usuario (API key
        o sistema), devuelve `SYSTEM`.
    *   `assertIsOrgAdmin(userId, orgId)`: lee `UserOrganization.role` y acepta
        `ADMIN` o `SUPERADMIN`.
*   **Por qué**: `@CheckPolicies` no protege nada sin Stripe.

##### 4. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository`,
    `ApprovalPolicyService` y `ApprovalNotifyService`. **No** depende de
    `PostsService` ni de Temporal.
*   **Cambios propuestos**:
    *   `enabled()`: `process.env.APPROVALS_ENABLED === 'true'`.
    *   `fingerprintsFromDb(orgId, batchId, integrationIds?)`:
        `Record<integrationId, sha256>`. Lee `getBatchRootPosts` y
        `findExistingMediaIds`, aplica las reglas de
        [Huella del contenido](#huella-del-contenido) (con
        `isAllowedMediaPath` del archivo 2b) y calcula
        `sha256(JSON.stringify(estructura))` con las claves ordenadas. Es el
        único cálculo de huella del fork.
    *   `referenceFingerprints(approval)`: `approvedFingerprints` en `APPROVED`,
        y si no, las de `lastEventWithFingerprints`.
    *   `evaluatePublish(orgId, postId): Promise<{ allowed: boolean; reason?: 'no_approval' | 'stage' | 'published' | 'fingerprint_drift' }>`:
        **sin efectos** y sin mirar si el post está en `QUEUE`.
        *   `allowed: true` si `!enabled()`;
        *   `reason: 'no_approval'` si no hay `PostApproval`; `'stage'` si la
            etapa no es `APPROVED`; `'published'` si el post raíz está en
            `PUBLISHED`; `'fingerprint_drift'` si la huella de su canal no
            coincide con `approvedFingerprints[integrationId]`.
        *   La usan los métodos `before*` y la conciliación.
    *   `isPublishAllowed(orgId, postId): Promise<boolean>`: solo la llama
        `getPostsList`.
        *   devuelve `true` si `!enabled()`;
        *   devuelve `false` si el post raíz no está en `QUEUE` o si
            `evaluatePublish` no lo permite;
        *   cuando devuelve `false`, inserta `BLOCKED_AT_PUBLISH` con el
            `reason` de `evaluatePublish` y suma `approval_blocked_at_publish`
            (en todos los casos, no solo con `fingerprint_drift`). Si el post
            no está en `QUEUE`, el `reason` es `'not_queued'`.
    *   `typeForSave(orgId, body)`:
        *   los canales con fecha pasada que no están en `PUBLISHED` y piden
            `schedule` se guardan como `draft` (en vez de rechazar toda la
            petición), y se registra `BLOCKED` con `reason: 'past_date'`. Así un
            lote aprobado con un canal en `ERROR` y fecha vieja no bloquea a los
            demás;
        *   devuelve `{ typeByIntegration, inter }`;
        *   con `!enabled()`, devuelve el tipo pedido para todos los canales y
            el `inter` del cuerpo;
        *   para cada canal, según los ids del cuerpo: `update` si el post raíz
            existente está en `PUBLISHED` (y rechaza `republish: true` con
            `BadRequestException`); `draft` si se pidió `schedule` o `now`; si
            no, el tipo pedido;
        *   `inter` siempre sale `undefined`.
    *   `afterSave(orgId, savedRootIds, requestedType, actor, surface)`:
        *   devuelve `{ toQueue: postId[], toDraft: postId[], stageByPostId }`.
            Nunca escribe `Post.state` ni toca Temporal: lo hace `PostsService`
            con esas listas;
        *   con `!enabled()`, devuelve listas vacías y no hace nada;
        *   agrupa los posts por `batchId` con `getBatchIdsForPosts`. Para cada
            lote:
            1.  si no hay `PostApproval`, lo crea con `createApproval`, y el
                evento `CREATED` lleva el actor, su rol (`actorRoleFor`),
                `surface` y las huellas;
            2.  calcula `fingerprintsFromDb` solo para los canales guardados y
                los compara con `referenceFingerprints`;
            3.  si alguna cambió, inserta `CONTENT_EDITED` con las huellas de
                todo el lote;
            4.  si cambió y la etapa es `IN_REVIEW`, `AWAITING_FINAL` o
                `APPROVED`: ejecuta `transition` a `IN_REVIEW` con
                `approvedFingerprints = null` y el evento `RESET_BY_EDIT`. Si
                `transition` devuelve `false`, relee la aprobación y repite una
                vez; si vuelve a fallar, escribe un error en el log y deja el
                lote fuera de `toQueue`. Agrega a `toDraft` los posts raíz del
                lote que no están en `PUBLISHED` ni ya en `DRAFT`, y llama a
                `notifyRole(orgId, 'REVIEWER', 'RESET_BY_EDIT', data)`. Suma
                `approval_reset`;
            5.  si no cambió, la etapa es `APPROVED` y `requestedType` es
                `schedule` o `now`, agrega a `toQueue` los posts raíz guardados
                que no están en `PUBLISHED`;
            6.  si se pidió `schedule` o `now` y no se programó, inserta
                `BLOCKED` y suma `approval_blocked`;
            7.  llama a `updateEarliestPublishDate` y llena `stageByPostId`.
    *   `beforeChangeDate(orgId, postId, date, action, republish)`: devuelve la
        `action` final.
        *   Rechaza una fecha pasada con `BadRequestException('La fecha de
            publicación ya pasó')`.
        *   Rechaza `republish: true` solo si el post raíz está en `PUBLISHED`.
        *   En `PUBLISHED`, devuelve `update`.
        *   Si el post raíz está en `QUEUE` y `action` es `update`, devuelve
            `schedule`.
        *   Si la `action` final es `schedule`, el post no está en `DRAFT` y
            `evaluatePublish` no lo permite, devuelve `{ action: 'update',
            toDraft: [postId] }`. `PostsService` pasa el post a `DRAFT` y
            llama a `startWorkflow(DRAFT)`.
        *   Devuelve `{ action, toDraft }`.
    *   `afterChangeDate(orgId, postId, actor)`: se llama después de escribir.
        Registra `DATE_CHANGED` si la etapa es `APPROVED` y llama a
        `updateEarliestPublishDate`.
    *   `beforeChangePostStatus(orgId, postId, status)`:
        *   `draft` siempre pasa;
        *   `schedule` lanza `BadRequestException('Este post necesita
            aprobación final')` si `evaluatePublish` no lo permite (incluido
            `'published'`). Con una fecha pasada, lanza
            `'La fecha de publicación ya pasó'`.
    *   `beforeDeletePost(orgId, group)`: solo lee, con `getRootPostByGroup`, el
        post raíz y su lote, y devuelve ese contexto. No escribe nada, para que
        un borrado de upstream que falle no deje eventos.
    *   `afterDeletePost(orgId, context, actor, surface)`: se llama después de
        borrar. Devuelve `{ toDraft }`.
        *   si el post raíz estaba en `ERROR` o en pausa en un lote `APPROVED`,
            inserta `CHANNEL_DISCARDED` con el actor y no reinicia;
        *   si el lote está en `IN_REVIEW`, `AWAITING_FINAL` o `APPROVED`,
            calcula las huellas **sin** el canal borrado, inserta
            `CONTENT_EDITED`, ejecuta la transición a `IN_REVIEW` con
            `RESET_BY_EDIT` y agrega a `toDraft` los demás posts raíz;
        *   en las demás etapas, inserta `CONTENT_EDITED`.
    *   `plugsEnabled()`: `!enabled()`.
*   **Por qué**: es el único lugar donde se aplica la regla central.

##### 5. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository`,
    `ApprovalPolicyService`, `ApprovalGateService`, `ApprovalNotifyService` y
    `PostsService`.
*   **Cambios propuestos**: todas las acciones reciben `version`. Siguen estos
    pasos:
    1.  Cargan la aprobación (404 si no existe en la organización).
    2.  Llaman a `assertCan`.
    3.  Validan la etapa de origen.
    4.  Ejecutan `transition(id, version, data, events)`. Si devuelve `false`,
        lanzan `ConflictException` (409).
    5.  Envían los avisos con `ApprovalNotifyService`.

    Las acciones son:
    *   `submit(orgId, batchId, version, actor, quickTopic?)`:
        *   si no hay brief ni `quickTopic`, lanza `BadRequestException('Falta
            el tema')`. Con `quickTopic`, crea un `ContentBrief` con
            `quickBrief = true` y `LINKED_BRIEF`;
        *   valida cada canal con `PostsService.validatePosts`. Arma la entrada
            con `getPostsRecursively` por cada post raíz, igual que
            `updatePostSettings` (`posts.service.ts:1287-1307`). Un canal falla
            si `!valid || errors !== true || emptyContent || tooLong`, y se lanza
            `BadRequestException` con `${name}: <mensaje>`, igual que
            `updatePostSettings` (`posts.service.ts:1309-1334`).
            `PostValidationException` vive en `apps/backend` y no se puede
            importar desde `libraries`;
        *   `SUBMITTED` guarda las huellas y el `snapshot`.
    *   `reviewApprove(orgId, batchId, version, actor)`: la huella actual tiene
        que coincidir con la de referencia; `REVIEW_APPROVED` guarda las huellas
        y el `snapshot`.
    *   `reject(orgId, batchId, version, actor, commentText)`:
        *   crea el comentario sobre el primer post raíz del lote por
            `createdAt`, con
            `PostsService.createPublicComment(rootId, { content: commentText } as CreatePublicCommentDto, actor.id, '')`;
        *   guarda el `id` en `event.commentId` y el texto en `event.reason`.
    *   `finalApprove(orgId, [{ batchId, version }], actor)`: procesa cada lote
        por separado y devuelve `[{ batchId, ok, error? }]`. Para cada lote:
        1.  La huella actual tiene que coincidir con la del último
            `REVIEW_APPROVED`.
        2.  Las fechas de los posts raíz que no están en `PUBLISHED` tienen que
            estar en el futuro.
        3.  Ejecuta `transition` a `APPROVED` con `approvedFingerprints` y el
            `snapshot`.
        4.  Llama a `changePostStatus(orgId, rootId, 'schedule')` por cada post
            raíz que no esté en `PUBLISHED`. Si una llamada falla, pasa a
            `DRAFT` los que ya se habían programado (con
            `changePostStatus('draft')`), vuelve el lote a `AWAITING_FINAL` con
            otra `transition` que borra `approvedFingerprints` y registra
            `BLOCKED` con `reason: 'final_approval_failed'`, y devuelve
            `ok: false`.
    *   `force(orgId, batchId, version, actor, reason)`:
        *   la etapa de origen es `IN_PRODUCTION`, `CHANGES_REQUESTED`,
            `IN_REVIEW` o `AWAITING_FINAL`;
        *   `assertCan(…, 'FORCED', …)` aplica la regla de autoría;
        *   valida igual que `submit`;
        *   ejecuta `transition` a `APPROVED` con las huellas actuales en
            `approvedFingerprints`, `forced = true` y el evento `FORCED` con
            `reason`;
        *   para cada post raíz que no está en `PUBLISHED`: si su fecha ya
            pasó, llama a `changeDate(orgId, rootId, ahora + 1 minuto,
            'update')`; después llama a `changePostStatus(orgId, rootId,
            'schedule')`;
        *   suma `approval_forced` y usa la plantilla `FORCED`.
    *   `verify(orgId, batchId, version, actor)`: de `PUBLISHED` a `VERIFIED`, y
        fija `verifiedAt` y `verifiedById`.
    *   `markProblem(orgId, batchId, version, actor, commentText)`:
        *   crea el comentario igual que `reject`;
        *   crea un `ContentBrief` con `correctionOfApprovalId` y como tema
            "Corrección: " seguido del tema original;
        *   pasa a `VERIFICATION_PROBLEM`.
    *   `linkBrief(orgId, batchId, version, briefId, actor)`: solo en
        `IN_PRODUCTION` o `CHANGES_REQUESTED`, por el Creator o el Technical
        Writer. Registra `LINKED_BRIEF`.
    *   **Lecturas** (interfaces en el archivo 10):
        *   `getInbox(orgId, actor)`: `InboxItem[]`, con las etapas según los
            roles del actor: Creator → `IN_PRODUCTION` y `CHANGES_REQUESTED`;
            Reviewer → `IN_REVIEW`; Monthly Reviewer → `AWAITING_FINAL`;
            Technical Writer → `PUBLISHED`;
        *   `getBatch(orgId, batchId)`: `BatchDetail`;
        *   `getStages(orgId, postIds[])`;
        *   `getRoles(orgId)`: `RoleRow[]`, con **todos** los miembros no
            deshabilitados, tengan roles o no.
    *   **Preview:**
        *   `getPreview(orgId, postId)`: llama a
            `getPostsRecursively(postId, true, orgId)` y aplica el mismo mapeo
            que `public.controller.ts:57-74`. Quita `childrenPost` y `batchId`,
            y deja `integration` solo con `id`, `name`, `picture`,
            `providerIdentifier` y `profile`. Así no se exponen tokens.
        *   `getPreviewComments(orgId, postId)`: devuelve
            `{ comments: await PostsService.getComments(postId) }`, solo si el
            post es de la organización.
    *   `setRoles(orgId, userId, roles[], actor)`: llama a `assertIsOrgAdmin`.
        Si `userId` no es miembro, lanza `NotFoundException`.
*   **Implementado (fase 3):**
    *   `reviewApprove` compara la huella con el último `SUBMITTED` o
        `RESET_BY_EDIT`, y `finalApprove` con el último `REVIEW_APPROVED`
        (`lastEventWithFingerprints` recibe la lista de acciones). Un
        `CONTENT_EDITED` cuyo reinicio falló nunca sirve de referencia.
    *   `reject` y `markProblem` comprueban la `version` antes de crear el
        comentario, para no dejar comentarios sueltos con un `409`.
    *   En `force`, mover la fecha pasada y programar van dentro del mismo
        `try`: si algo falla, el lote vuelve a su etapa original con
        `forced = false` y sin `approvedFingerprints`. Si la `transition` de
        vuelta pierde la carrera, se escribe un error en el log; la
        comprobación de `getPostsList` sigue impidiendo la publicación.
    *   Los mensajes de error del fork están en español.
*   **Por qué**: aquí vive la lógica de cada paso del flujo.

##### 6. `libraries/nestjs-libraries/src/database/prisma/approvals/briefs.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository` y
    `ApprovalPolicyService`.
*   **Cambios propuestos**:
    *   `list(orgId, status?)`, `create(orgId, actor, dto)`,
        `update(orgId, id, actor, dto)` y `cancel(orgId, id, actor)`.
    *   Crear, editar y cancelar exigen el rol `TECHNICAL_WRITER`. Los briefs con
        `quickBrief = true` también los puede editar quien los creó.
    *   `get(orgId, id)`, para abrir el editor desde un brief.
    *   **Estados del brief:**

        | Desde | Evento | Hacia |
        |---|---|---|
        | (nada) | Creado por el Writer, brief rápido o brief de corrección | `OPEN` |
        | `OPEN` o `IN_PRODUCTION` | `LINKED_BRIEF` | `IN_PRODUCTION` |
        | `IN_PRODUCTION` | El lote pasa a `PUBLISHED` (paso 3 de la tarea) | `DONE` |
        | `OPEN` o `IN_PRODUCTION` | `cancel` | `CANCELLED` |

        Un brief se puede enlazar a varios lotes. `linkBrief` rechaza con
        `400` los briefs en `DONE` o `CANCELLED`. Un brief pasa a `DONE`
        cuando su último lote enlazado llega a `PUBLISHED`.
*   **Por qué**: gestiona el tema antes de que exista un post.

##### 7. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.sweep.service.ts` (Create)

*   **Tipo / alcance**: servicio de NestJS. Depende de `ApprovalsRepository`,
    `ApprovalGateService`, `ApprovalNotifyService` y `PostsService`.
*   **Cambios propuestos**:
    *   `run(now)`: sale si `!this._gate.enabled()`. Si no, recorre
        `listOrgIdsToSweep()` y ejecuta, en orden, los pasos de la
        [tabla de la tarea de mantenimiento](#tarea-de-mantenimiento-approvalsweepworkflow).
        Cada paso va en su propio `try/catch`.
    *   `reconcile({ startup })`: sale si `!enabled()`. Ejecuta solo los pasos
        5a a 5e. Para pasar un post a `DRAFT` usa
        `PostsService.changePostStatus(orgId, postId, 'draft')`, que llama a
        `startWorkflow(DRAFT)` y termina su workflow. Con `startup`, registra
        `reason: 'startup'` y no avisa.
    *   **Paso 5a, en orden:**
        1.  Lee el último `BLOCKED_AT_PUBLISH` del post (lo registró
            `isPublishAllowed`), así que no inserta otro.
        2.  Si su `reason` es `fingerprint_drift`, avisa a los Monthly Reviewer
            con la plantilla `BLOCKED_AT_PUBLISH`. Si no, avisa a los ADMIN.
        3.  Pasa el post a `DRAFT` con `changePostStatus(orgId, postId, 'draft')`.
        4.  Si el lote estaba `APPROVED`: `transition` a `IN_REVIEW` con
            `approvedFingerprints = null` y el evento `RESET_BY_EDIT` con
            `actorRole = SYSTEM`. Los demás posts raíz del lote que no están en
            `PUBLISHED` pasan a `DRAFT` con `changePostStatus('draft')`.
    *   **Paso 5e:** un lote "perdió un canal" si un `integrationId` de las
        huellas de referencia no tiene un post raíz no borrado y no hay un
        `CHANNEL_DISCARDED` para él.
    *   Suma `approval_expired` en el paso 1 y `approval_reconciled` en 5b.
*   **Implementado (fase 4):**
    *   La conciliación corre 5d antes que 5a, 5b y 5c: un lote guardado con el
        fork apagado se adopta (`CREATED` por `SYSTEM`) antes de que 5b tome
        sus posts en `QUEUE` como no aprobados.
    *   5d solo adopta lotes con posts raíz en `QUEUE`, o en `ERROR` con fecha
        de los últimos 30 días. Un borrador recibe su `PostApproval` al
        guardarse. `listOrgIdsToSweep` usa el mismo límite para `ERROR`, así
        la tarea no recorre años de historial.
    *   Cada paso que pasa un post a `DRAFT` lo "reclama" primero con
        `claimDraft` (un `updateMany` condicionado al estado actual). Solo quien
        lo movió escribe el evento y envía el aviso, así que dos tareas al mismo
        tiempo (por ejemplo, la conciliación de arranque y el primer paso del
        workflow) no duplican nada. En 5a, el post se mueve antes de avisar.
    *   `CHANNEL_DISCARDED` guarda el canal en `snapshot.integrationId`, no en
        `reason`, para no mezclarlo con los motivos que muestra el historial.
    *   Cuando 5a devuelve un lote `APPROVED` a `IN_REVIEW`, avisa a los
        Reviewer con la plantilla `RESET_BY_EDIT`, igual que una edición.
    *   El workflow atrapa el error de una actividad que agotó sus reintentos y
        espera la vuelta siguiente, en lugar de terminar. El tiempo máximo de la
        actividad es 10 minutos, como en `missingPostWorkflow`.
    *   La conciliación de arranque solo corre en la réplica con `RUN_CRON`.
    *   **Mejora futura:** 5a, 5b y 5e evalúan cada post con varias consultas.
        Con muchos posts conviene cargar aprobaciones y posts raíz una vez por
        organización y comparar en memoria.
*   **Por qué**: ejecuta lo que depende del tiempo (vencimientos, avisos,
    confirmación de la publicación) y devuelve a `DRAFT` los posts bloqueados.

##### 8. `libraries/nestjs-libraries/src/database/prisma/database.module.ts` (Modify, upstream)

*   **Tipo / alcance**: módulo de NestJS.
*   **Cambios propuestos**: se agregan a `providers`, por fases:
    *   fase 2: `ApprovalsRepository`, `ApprovalNotifyService`,
        `ApprovalPolicyService` y `ApprovalGateService`;
    *   fase 3: `ApprovalService` y `BriefsService`;
    *   fase 4: `ApprovalSweepService`.
*   **Por qué**: los inyectan el backend y el orquestador.

##### 9. `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` (Modify, upstream)

*   **Tipo / alcance**: servicio de upstream. Cada cambio va marcado con
    `// FORK: approvals`.
*   **Cambios propuestos**:
    1.  **Constructor:** inyecta `ApprovalGateService`.
    2.  **`isAllowedMediaPath`:** se reemplaza por el import del archivo 2b.
    3.  **`createPost(orgId, body, creationMethod, keepGroup, actorUserId?)`:**
        *   antes de `guardAgainstRepublish` y del bucle, llama a
            `typeForSave`;
        *   dentro del bucle usa `decision.typeByIntegration[post.integration.id]`
            y `decision.inter` en lugar de `body.type` y `body.inter`, también
            en la condición que inicia el workflow;
        *   `guardAgainstRepublish` usa `decision.typeByIntegration` en lugar de
            `body.type`. Con el fork activo no hace falta, porque `typeForSave`
            ya rechaza `republish` en `PUBLISHED`, pero se deja para el caso con
            el fork apagado;
        *   la fecha de un canal sigue la regla de upstream con `body.type`: si
            se pidió `now`, se guarda `dayjs()`, aunque el canal se guarde como
            `draft`;
        *   con el fork activo, dentro del bucle **no** se llama a
            `startWorkflow` para los canales guardados como `draft`. En su lugar
            se hace después, con `await`, para evitar la carrera entre la
            terminación del bucle y el `startWorkflow(QUEUE)` de `toQueue`;
        *   el bucle va dentro de `try { … } finally { … }`. En el `finally`,
            envuelto en su propio `try/catch` que escribe en el log y no oculta
            el error original, se llama a `afterSave(orgId, savedRootIds,
            body.type, actorUserId, creationMethod)`. Después, en orden y con
            `await`:
            1.  para cada post raíz guardado como `draft` o en `toDraft`, que
                no esté en `toQueue`: `setRootPostsDraft` (solo si está en
                `toDraft`) y `startWorkflow(provider, id, orgId, 'DRAFT')`, que
                termina sus workflows. Los canales guardados con `update` no
                pasan por aquí, igual que en upstream, para no terminar el
                workflow de un post en `QUEUE` que no cambió;
            2.  para cada `postId` de `toQueue`:
                `const { integration } = await this._postRepository.changeState(postId, 'QUEUE')`
                y `startWorkflow(integration.providerIdentifier.split('-')[0].toLowerCase(), postId, orgId, 'QUEUE')`;
        *   **Implementado:** si el bucle terminó bien pero `afterSave` o el
            procesamiento de las listas fallan, el error se registra en el log
            y se relanza: lo pedido como `schedule` quedó en `DRAFT`, y quien
            llamó tiene que saberlo. Si el bucle ya había fallado, se relanza
            el error del bucle. En `changeDate`, los errores posteriores a
            guardar la fecha solo se registran en el log;
        *   el `return postList` se mueve después del `finally`, y cada elemento
            agrega `approvalStage: stageByPostId[postId]`. Consumidores de la
            respuesta, revisados contra upstream: `posts.controller.ts:248`,
            `public.integrations.controller.ts:230` e
            `integration.schedule.post.ts:256` devuelven la respuesta tal cual;
            `updatePostSettings` (`posts.service.ts:1339`) solo usa `postId`; y
            autopost, clipping y `generatePostsDraft` la ignoran. Ninguno valida
            la forma del objeto, así que `approvalStage` no cambia su
            comportamiento.
    4.  **`changeDate(orgId, id, date, action, republish, actorUserId?, creationMethod?)`:**
        llama a `beforeChangeDate` antes de `guardAgainstRepublish`, usa la
        `action` que devuelve, procesa `toDraft` igual que `createPost` y,
        después de escribir, llama a `afterChangeDate`.
    5.  **`changePostStatus`:** llama a `beforeChangePostStatus` antes de
        `changeState`.
    6.  **`deletePost(orgId, group, actorUserId?, creationMethod?)`:** llama a
        `beforeDeletePost` antes de borrar y a `afterDeletePost` después, y
        procesa `toDraft` igual que `createPost`.
    7.  **`checkInternalPlug` y `checkPlugs`:** al inicio,
        `if (!this._approvalGate.plugsEnabled()) return [];`.
    *   **Implementado (fase 2):** `PostsService` llama a `setRootPostsDraft`
        a través de `ApprovalGateService.setRootPostsDraft`, para no inyectar
        un repositorio ajeno. `changeDate` y `deletePost` reciben
        `creationMethod` con valor por defecto `'UNKNOWN'` hasta que la fase 3
        actualice los llamadores (archivos 16 y 17).
    8.  **Llamadores:** `posts.controller.ts` pasa `user.id` y `'WEB'` (en
        `createPost`, con `keepGroup = false` explícito);
        `public.integrations.controller.ts:240, 249 y 558` pasan `undefined` y
        `'API'`; las herramientas MCP pasan `'MCP'`.
*   **Por qué**: `createPost`, `changeDate` y `changePostStatus` son los únicos
    métodos que escriben `QUEUE` (`updatePostSettings` pasa por `createPost`).
    `deletePost` se toca para reiniciar la aprobación o registrar
    `CHANNEL_DISCARDED`; `checkInternalPlug` y `checkPlugs`, para apagar los
    plugs, que publican sin pasar por el punto de control. Cada cambio delega
    la decisión en `ApprovalGateService`; `createPost` es el único método
    donde además cambia el flujo local (el `try/finally` y las listas
    `toQueue` y `toDraft`).

##### 9b. `apps/orchestrator/src/activities/post.activity.ts` (Modify, upstream)

*   **Tipo / alcance**: actividad de Temporal. Solo cambia el cuerpo de
    `getPostsList`; los parámetros no cambian.
*   **Cambios propuestos**:
    *   el constructor inyecta `ApprovalGateService`;
    *   en `getPostsList(orgId, postId)`, justo después de la comprobación de la
        suscripción de Stripe (líneas 175-181), se agrega
        `if (!(await this._approvalGate.isPublishAllowed(orgId, postId))) { return []; }`,
        marcado con `// FORK: approvals`.
*   **Por qué**: es la garantía de la regla central. `postWorkflowV112` llama a
    `getPostsList` después de dormir (`post.workflow.v1.1.2.ts:182`), y con `[]`
    termina en `ERROR 'No Post'` sin publicar.

##### 10. `libraries/nestjs-libraries/src/dtos/approvals/approval.actions.dto.ts` (Create)

*   **Tipo / alcance**: DTOs de `class-validator` e interfaces de respuesta.
*   **Cambios propuestos**:
    *   `VersionDto { version: number (entero, ≥ 0) }`.
    *   `SubmitApprovalDto extends VersionDto { quickTopic?: string (máx. 140) }`.
    *   `RejectApprovalDto extends VersionDto { comment: string (mín. 3, máx. 2000) }`.
    *   `FinalApproveDto { items: { batchId: string, version: number }[] (1 a 50) }`.
    *   `ForceApprovalDto extends VersionDto { reason: string (mín. 10) }`.
    *   `ProblemApprovalDto extends VersionDto { comment: string (mín. 3, máx. 2000) }`.
    *   `LinkBriefDto extends VersionDto { briefId: string }`.
    *   `StagesQueryDto { postIds: string[] (máx. 500) }`.
    *   `SetWorkflowRolesDto { roles: WorkflowRole[] }`.
    *   **Respuestas:**
        *   `InboxItem { batchId, version, stage, expired, brief: { id, topic, quickBrief } | null, earliestPublishDate, posts: { id, group, integrationId, state, publishDate }[] }`.
        *   `BatchDetail { batchId, version, stage, expired, forced, brief, posts: { id, group, integrationId, state, error, publishDate }[], history: { action, actorName, actorRole, surface, reason, createdAt }[] }`.
        *   `RoleRow { userId, name, email, roles: WorkflowRole[] }`.
        *   `StagesMap { [postId]: { batchId, stage, version, expired } }`.

##### 11. `libraries/nestjs-libraries/src/dtos/approvals/brief.dto.ts` (Create)

*   **Tipo / alcance**: DTOs de `class-validator`.
*   **Cambios propuestos**:
    *   `CreateBriefDto { topic (obligatorio, máx. 200), baseCopy?, targetDate?, assignedCreatorId? }`.
    *   `UpdateBriefDto`, con los mismos campos opcionales.

##### 12. `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts` (Modify, upstream)

*   **Tipo / alcance**: registro de workflows infinitos. Este módulo se carga
    en el backend (`apps/backend/src/app.module.ts:34`).
*   **Cambios propuestos**:
    *   Dentro del mismo `if (!!process.env.RUN_CRON)`, se agrega
        `workflow.start('approvalSweepWorkflow', { workflowId: 'approval-sweep-workflow', taskQueue: 'main' })`
        con su propio `try/catch`.
    *   Se inyecta `ApprovalSweepService`. Si `APPROVALS_ENABLED=true`, al final
        de `onModuleInit` se lanza **sin `await`** `reconcile({ startup: true })`,
        con hasta 3 reintentos separados por 10 segundos.
    *   Si `APPROVALS_ENABLED=true` y `RUN_CRON` no está definida, se escribe un
        error en el log.
*   **Por qué**: arranca la tarea de mantenimiento igual que
    `missingPostWorkflow`, y concilia al arrancar.

#### C. Backend (API)

##### 13. `apps/backend/src/api/routes/approvals.controller.ts` (Create)

*   **Tipo / alcance**: controlador de NestJS. Usa `GetOrgFromRequest`,
    `GetUserFromRequest` y `@Req()`, e inyecta `ApprovalService`.
*   **Cambios propuestos**: todas las rutas delegan en `ApprovalService`.
    *   **Lecturas:**
        *   `GET /approvals/inbox`;
        *   `GET /approvals/batch/:batchId`;
        *   `POST /approvals/stages` (body `StagesQueryDto`);
        *   `GET /approvals/preview/:postId`;
        *   `GET /approvals/preview/:postId/comments`;
        *   `GET /approvals/roles`.
    *   **Acciones del flujo:**
        *   `POST /approvals/batch/:batchId/submit`;
        *   `POST /approvals/batch/:batchId/review-approve`;
        *   `POST /approvals/batch/:batchId/reject`;
        *   `POST /approvals/final-approve`;
        *   `POST /approvals/batch/:batchId/force`;
        *   `POST /approvals/batch/:batchId/verify`;
        *   `POST /approvals/batch/:batchId/problem`;
        *   `POST /approvals/batch/:batchId/link-brief`.
    *   **Roles:** `PUT /approvals/roles/:userId`.
    *   **Suplantación:** cada ruta `POST` o `PUT` llama a un método privado
        `assertNotImpersonating(req)`. Lanza `ForbiddenException` si
        `req.user?.isSuperAdmin` y
        (`req.cookies.impersonate || req.headers.impersonate`), que es la misma
        condición de `auth.middleware.ts:60-61`.
*   **Implementado (fase 3):** los dos controladores llevan
    `@UseGuards(ApprovalsEnabledGuard)`, que responde `404` en todas sus rutas
    si `APPROVALS_ENABLED` no es `'true'`. El guard y la función
    `assertNotImpersonating` viven en
    `apps/backend/src/services/auth/approvals.guard.ts` (archivo 13b), para
    que la condición copiada del middleware esté en un solo lugar.
    `POST /approvals/stages` es una lectura y no rechaza la suplantación.
    `SetWorkflowRolesDto` usa `@ArrayUnique()`, y `GET /briefs` valida
    `status` con `ListBriefsQueryDto`.
*   **Por qué**: es la única entrada a las acciones del flujo. Solo se puede
    usar con sesión web, nunca con API key ni desde MCP, y nunca con
    suplantación.

##### 14. `apps/backend/src/api/routes/briefs.controller.ts` (Create)

*   **Tipo / alcance**: controlador de NestJS.
*   **Cambios propuestos**: `GET /briefs?status=`, `GET /briefs/:id`,
    `POST /briefs`, `PUT /briefs/:id` y `DELETE /briefs/:id` (cancelar). Delegan en
    `BriefsService`. Las rutas que cambian algo también llaman a
    `assertNotImpersonating`.

##### 15. `apps/backend/src/api/api.module.ts` (Modify, upstream)

*   **Tipo / alcance**: módulo de NestJS.
*   **Cambios propuestos**: se agregan `ApprovalsController` y
    `BriefsController` a `authenticatedController`.

##### 16. `apps/backend/src/api/routes/posts.controller.ts` (Modify, upstream)

*   **Tipo / alcance**: controlador de upstream.
*   **Cambios propuestos**:
    *   `createPost` (`POST /posts`), `changeDate` (`PUT /posts/:id/date`) y
        `deletePost` (`DELETE /posts/:group`) reciben
        `@GetUserFromRequest() user` y pasan `user.id` como `actorUserId`;
    *   el endpoint de comentarios (líneas 85-93) comprueba que el post sea de
        la organización antes de crear el comentario.
*   **Implementado (fase 3):** la comprobación de organización del endpoint
    de comentarios vive en `PostsService.createPublicComment`, que recibe un
    `orgId` opcional (`// FORK`). Este cambio aplica también con
    `APPROVALS_ENABLED=false`: cierra un hueco de upstream y se registra en
    `FORK_TOUCHPOINTS.md`. `public.integrations.controller.ts` (`deletePost`)
    y la herramienta MCP `delete.post.tool.ts` pasan `'API'` y `'MCP'` como
    superficie.
*   **Por qué**: el historial necesita saber quién editó, y se cierra el
    comentario cruzado entre organizaciones.

##### 17. `apps/backend/src/api/routes/public.controller.ts` (Modify, upstream)

*   **Tipo / alcance**: controlador de upstream. Inyecta `ApprovalGateService`.
*   **Cambios propuestos**: si `enabled()`, `GET /public/posts/:id`,
    `GET /public/posts/:id/comments` y `POST /public/posts/:id/comments`
    responden `NotFoundException`.
*   **Por qué**: cumple la meta 12.

##### 18. `apps/backend/src/api/routes/integrations.controller.ts` (Modify, upstream)

*   **Tipo / alcance**: controlador de upstream. Inyecta `ApprovalGateService`.
*   **Cambios propuestos**: si `enabled()`, `POST /:id/plugs` y
    `PUT /plugs/:id/activate` responden `BadRequestException('Los plugs están
    desactivados en esta instalación')`.
*   **Por qué**: impide configurar plugs que no se ejecutan con
    `APPROVALS_ENABLED=true`.

#### D. Orquestador

##### 19. `apps/orchestrator/src/workflows/approval.sweep.workflow.ts` (Create)

*   **Tipo / alcance**: workflow de Temporal.
*   **Cambios propuestos**: misma forma que `missing.post.workflow.ts`, sin
    `patched()` porque es un workflow nuevo:

    ```ts
    const { approvalSweep } = proxyActivities<ApprovalActivity>({
      startToCloseTimeout: '5 minute',
      retry: { maximumAttempts: 3, backoffCoefficient: 1, initialInterval: '1 minute' },
    });
    export async function approvalSweepWorkflow() {
      let loops = 0;
      await approvalSweep();
      while (true) {
        await sleep('15 minutes');
        if (++loops >= 96 || workflowInfo().historyLength > 1000) {
          return await continueAsNew<typeof approvalSweepWorkflow>();
        }
        await approvalSweep();
      }
    }
    ```

##### 20. `apps/orchestrator/src/workflows/index.ts` (Modify, upstream)

*   **Tipo / alcance**: índice de workflows.
*   **Cambios propuestos**: agrega `export * from './approval.sweep.workflow';`.

##### 21. `apps/orchestrator/src/activities/approval.activity.ts` (Create)

*   **Tipo / alcance**: clase de actividades con `@Activity` y
    `@ActivityMethod`, igual que `post.activity.ts`.
*   **Cambios propuestos**: `approvalSweep()` llama a
    `ApprovalSweepService.run(new Date())`. Si el fork está apagado, `run` sale
    sin hacer nada.

##### 22. `apps/orchestrator/src/app.module.ts` (Modify, upstream)

*   **Tipo / alcance**: módulo de NestJS.
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
        ids ordenados), `useWorkflowRoles()` y `useBriefs(status)`, `useBrief(id)`;
    *   acciones: funciones simples con `useFetch` (no son hooks de SWR) que
        devuelven la respuesta y llaman a `mutate`.

##### 26. `apps/frontend/src/components/approvals/approval.stage.badge.tsx` (Create)

*   **Cambios propuestos**: muestra la etiqueta de la etapa con su nombre en
    pantalla y un color tomado de `colors.scss`. Se usa en el calendario, la
    bandeja y el panel de aprobación.

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
    *   el botón "Crear post desde este brief", que navega a
        `/launches?briefId=<id>`. El componente del archivo 32b abre el editor
        con `baseCopy` como texto inicial.

##### 32b. `apps/frontend/src/components/briefs/open.from.brief.tsx` (Create)

*   **Tipo / alcance**: componente cliente.
*   **Cambios propuestos**:
    *   lee `briefId` con `useSearchParams` y, con `approvalsEnabled`, carga el
        brief con el hook `useBrief(id)` (archivo 25, sobre `GET /briefs/:id`);
    *   abre el editor con el mismo mecanismo que
        `apps/frontend/src/components/launches/new.post.tsx` (`AddEditModal`,
        líneas 50-75), y pasa `baseCopy` con la prop `onlyValues`
        (`add.edit.modal.tsx:33`);
    *   pone `briefId` en el `initialState` del store del editor, porque
        `reset()` corre al desmontar (`add.edit.modal.tsx:273-275`);
    *   se monta dentro de `LaunchesComponent`
        (`apps/frontend/src/components/launches/launches.component.tsx`, Modify,
        upstream), que es cliente. `launches/page.tsx` es un Server Component y
        no se toca.
*   **Por qué**: el editor es un modal que en upstream solo se abre desde el
    calendario, y `setFiltersWrapper` reescribe la URL
    (`calendar.context.tsx:335-341`), así que `briefId` se lee una sola vez al
    montar.

##### 33. `apps/frontend/src/app/(app)/(site)/briefs/page.tsx` (Create)

*   **Cambios propuestos**: la ruta `/briefs`, que monta el componente del
    archivo 32.

##### 34. `apps/frontend/src/components/new-launch/manage.modal.tsx` (Modify, upstream)

*   **Cambios propuestos** (solo con `approvalsEnabled`):
    *   monta `ApprovalPanel`, que recibe el `id` del post raíz;
    *   botones del editor:

        | Botón o etiqueta de upstream | Con el fork activo | `type` que envía |
        |---|---|---|
        | "Add to calendar" / "Schedule" | "Guardar" | `schedule` si la etapa del lote es `APPROVED`; si no, `draft` |
        | "Update" (`scheduleLabel` de un post existente, en `QUEUE` o `PUBLISHED`; `manage.modal.tsx:826-846`) | "Guardar" | Igual que el anterior |
        | "Post Now" | "Guardar" | Igual que el anterior. La hora no se cambia a "ahora". |
        | "Save as Draft" (línea 858) | "Pausar" si la etapa es `APPROVED`; si no, se oculta | `draft` |

        La etapa se conoce antes de guardar: al abrir un post existente, el
        editor llama a `useApprovalStages([rootPostId])` y obtiene el
        `batchId`, la etapa y la `version`. Un post nuevo usa `draft`.

    *   no se abren las preguntas de `saveAs` ni el modal de republicar
        (`manage.modal.tsx:321-549`), y nunca se envía `republish`. El bucle de
        una petición por tipo (líneas 752-789) se reemplaza por un solo
        `POST /posts` con todos los canales. Los canales en `PUBLISHED` y los
        de fecha pasada los resuelve el servidor (`typeForSave`);
    *   después de guardar, el editor llama a `POST /approvals/stages` con los
        `postId` de la respuesta para conocer el `batchId` y la `version`. Si el
        store tiene `briefId` y el lote no tiene brief, llama a `link-brief`.
*   **Por qué**: el editor tiene que mostrar el flujo y no prometer una
    publicación que no va a ocurrir.

##### 35. `apps/frontend/src/components/new-launch/store.ts` (Modify, upstream)

*   **Cambios propuestos**: agrega `briefId?: string` y su setter.

##### 36. `apps/frontend/src/components/launches/calendar.tsx` (Modify, upstream)

*   **Cambios propuestos**:
    *   llama a `useApprovalStages` con los ids de la semana o el mes visible y
        dibuja `ApprovalStageBadge` en cada post;
    *   en las líneas 843-844, el calendario abre el modal "What do you want to
        do?" al arrastrar un post en `PUBLISHED` o un post en `QUEUE` con fecha
        pasada. Con `approvalsEnabled`, ese modal no se abre: un post en
        `PUBLISHED` se mueve siempre con `action: 'update'`, y los demás con
        `schedule`;
    *   el arrastre mueve el post en pantalla antes de que responda el servidor
        y solo revisa `status !== 500` (líneas 907-926). Con `approvalsEnabled`,
        si la respuesta no es correcta (por ejemplo `400` por fecha pasada), se
        muestra un toast con el mensaje del servidor y se llama a
        `reloadCalendarView()`;
    *   la insignia de etapa usa `stagesByPostId` del contexto (archivo 37b), sin
        una petición por celda.

##### 37. `apps/frontend/src/components/launches/filters.tsx` (Modify, upstream)

*   **Cambios propuestos**: agrega un selector "Etapa". Todas las llamadas a
    `setFilters` del archivo (líneas 86-108) pasan también `approvalStage`, para
    no perderlo al navegar.

##### 37b. `apps/frontend/src/components/launches/calendar.context.tsx` (Modify, upstream)

*   **Cambios propuestos**:
    *   agrega `approvalStage?: ApprovalStage` a la interfaz de `setFilters`
        (líneas 64-69) y a `setFiltersWrapper` (319-344), que lo conserva en la
        URL;
    *   llama una sola vez a `useApprovalStages` con los ids visibles y expone
        `stagesByPostId`;
    *   filtra en el cliente los posts del calendario y los de la vista de lista
        (`listPosts`, línea 358) por `approvalStage`.
*   **Por qué**: `filters.tsx` guarda su estado en este contexto, que tiene una
    forma fija.

##### 38. `apps/frontend/src/components/layout/top.menu.tsx` (Modify, upstream)

*   **Cambios propuestos**: con `approvalsEnabled`, agrega las entradas
    "Aprobaciones" (`/approvals`) y "Briefs" (`/briefs`), visibles para todos
    los roles de Postiz. Usan como ícono el SVG de la entrada de lanzamientos
    (`/launches`), igual que las demás entradas.

##### 39. `apps/frontend/src/components/settings/workflow.roles.component.tsx` (Create)

*   **Cambios propuestos**: muestra una fila por miembro con cuatro casillas,
    una por rol de trabajo. Solo un ADMIN puede editarlas, y cada cambio llama a
    `PUT /approvals/roles/:userId`. Si hay menos de 2 Reviewer o menos de 2
    Monthly Reviewer, muestra una advertencia de dotación mínima.

##### 40. `apps/frontend/src/components/settings/teams.component.tsx` (Modify, upstream)

*   **Cambios propuestos**: con `approvalsEnabled`, monta
    `WorkflowRolesComponent` debajo de la lista de miembros.

##### 41. `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx` (Modify, upstream)

*   **Cambios propuestos**: es un Server Component, así que lee
    `process.env.APPROVALS_ENABLED` en lugar del contexto.
    *   Si vale `'true'`, llama a `internalFetch('/approvals/preview/' + id)`,
        que ya reenvía la cookie `auth`.
    *   Si la respuesta es 401 o 403, o no hay cookie `auth`, llama a
        `redirect('/auth/login')` de `next/navigation`.

##### 41b. `apps/frontend/src/components/preview/preview.comments.context.tsx` (Modify, upstream)

*   **Cambios propuestos**: con `approvalsEnabled`, la URL de lectura de las
    líneas 45 y 48 pasa de `/public/posts/${previewId}/comments` a
    `/approvals/preview/${previewId}/comments`. El archivo ya usa `useFetch`, y
    la respuesta conserva la forma `{ comments }`.
*   **Por qué**: el endpoint público responde `404` con el fork activo.

##### 41c. `apps/frontend/src/components/preview/comments.components.tsx` (Modify, upstream)

*   **Cambios propuestos**: las líneas 194-197 son el POST que crea un
    comentario, con una rama con sesión (`/posts/${previewId}/comments`) y otra
    anónima (`/public/posts/...`). Con `approvalsEnabled` siempre hay sesión, así
    que se usa siempre la rama con sesión, y se ocultan el campo de nombre y el
    reCAPTCHA del comentario anónimo.
*   **Por qué**: el endpoint público responde `404` con el fork activo.

##### 42. `libraries/react-shared-libraries/src/translation/locales/en/translation.json` y `.../es/translation.json` (Modify, upstream)

*   **Cambios propuestos**: agregan las claves con el prefijo `approvals_`, una
    por cada texto visible de los archivos 26 a 41c: nombres de etapas,
    botones del panel, títulos de la bandeja y de briefs, advertencias y
    mensajes de error. Cada clave tiene texto en inglés y en español. Las demás
    lenguas usan el inglés por defecto.

#### F. Infraestructura, documentación y CI

##### 43. `docker-compose.yaml` (Modify, upstream)

*   **Cambios propuestos**:
    *   `image` apunta a la imagen del fork (`${FORK_IMAGE}`);
    *   les da nombre a los volúmenes anónimos de `temporal-postgresql` y
        `temporal-elasticsearch`: `temporal-postgres-data` y `temporal-es-data`;
    *   agrega `APPROVALS_ENABLED: 'true'` y `RUN_CRON: 'true'` al
        `environment` del servicio de Postiz (sintaxis de mapa, como en las
        líneas 6-15), que corre el backend y el orquestador con pm2;
    *   declara `temporal-postgres-data` y `temporal-es-data` en el bloque
        `volumes:` de nivel superior (líneas 261-272);
    *   cambia `'7233:7233'` (línea 214) por `'127.0.0.1:7233:7233'` y
        `'8080:8080'` (línea 259) por `'127.0.0.1:8080:8080'`.

##### 44. `var/docker/docker-build.sh` (Modify, upstream)

*   **Cambios propuestos**: reemplaza los `--target` inexistentes por
    `docker build -t ${FORK_IMAGE} -f Dockerfile.dev . && docker push ${FORK_IMAGE}`.
    El registro y el login (`docker login`) van en el runbook.

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

*   **Cambios propuestos**: se ejecuta en cada PR, con estos pasos en orden:
    1.  `actions/checkout` con `fetch-depth: 0`.
    2.  `actions/setup-node` con Node 22 y `pnpm/action-setup` con pnpm 10.6.1.
    3.  Servicio `postgres:17` para las pruebas, `pnpm install --frozen-lockfile`,
        `pnpm prisma-generate` y `pnpm prisma-db-push` contra esa base.
    4.  `git remote add upstream https://github.com/gitroomhq/postiz-app.git && git fetch upstream main`.
    5.  `git show upstream/main:libraries/nestjs-libraries/src/database/prisma/schema.prisma > /tmp/upstream.prisma`
        y `node scripts/fork/check-schema-additive.mjs /tmp/upstream.prisma libraries/nestjs-libraries/src/database/prisma/schema.prisma`.
    6.  `pnpm lint:fork`.
    7.  `pnpm build`.
    8.  `pnpm test:fork`.

    Los workflows de upstream (`build.yml`, `build-containers.yml`,
    `build-extension.yaml`, `codeql.yml`, `deploy-aws.yml`, `eslint`,
    `issue-label-triggers.yml`, `publish-extension.yml`, `staging-conflicts.yml`
    y `stale.yml`) no se editan. Se desactivan desde la
    configuración de GitHub Actions del repo del fork.

##### 48. `jest.fork.config.ts` (Create)

*   **Cambios propuestos**: configuración de `ts-jest` (ya está en
    `package.json`). Tiene `moduleNameMapper` generado desde
    `tsconfig.base.json`, `testMatch` sobre `**/approvals/**/*.spec.ts` y
    `**/*.approvals.spec.ts`, entorno `node` y `passWithNoTests: true`. Activa
    `collectCoverage` y fija
    `coverageThreshold` con `branches: 90` para `approval.gate.service.ts`,
    `approval.service.ts` y `approval.policy.service.ts`.
*   **Por qué**: el `jest.config.ts` de la raíz depende de `@nx/jest`, que no
    está en `package.json`. Una configuración propia evita tocarlo.

##### 49. `package.json` (Modify, upstream)

*   **Cambios propuestos**: agrega dos scripts:
    *   `"test:fork": "jest -c jest.fork.config.ts"`;
    *   `"lint:fork": "eslint libraries/nestjs-libraries/src/database/prisma/approvals libraries/nestjs-libraries/src/dtos/approvals apps/backend/src/api/routes/approvals.controller.ts apps/backend/src/api/routes/briefs.controller.ts apps/orchestrator/src/workflows/approval.sweep.workflow.ts apps/orchestrator/src/activities/approval.activity.ts apps/frontend/src/components/approvals apps/frontend/src/components/briefs"`.
        Se limita a los archivos del fork porque el lint del repo completo con
        el `eslint.config.mjs` de la raíz nunca se ejecuta en upstream y puede
        fallar por código ajeno. Antes de la fase 1 se comprueba que el comando
        termina con código 0.
    *   **Implementado (fase 1):** el `eslint.config.mjs` de la raíz no carga con
        ESLint 8.57 y `eslint-config-next` 16 (error "Converting circular
        structure to JSON"). Por eso `lint:fork` usa su propia configuración,
        `eslint.fork.config.mjs` (archivo 49b), con `ESLINT_USE_FLAT_CONFIG=true`,
        `--no-error-on-unmatched-pattern` (las rutas de fases futuras aún no
        existen) y `--max-warnings 0`. Aplica las mismas reglas apagadas que la
        raíz más `react-hooks/rules-of-hooks`.
    *   `pnpm build` necesita `NODE_OPTIONS=--max-old-space-size=4096`, como
        `Dockerfile.dev`. Con el límite por defecto, el build del backend se
        queda sin memoria en una máquina de 8 GB.

##### 50. `FORK_TOUCHPOINTS.md` (Create)

*   **Cambios propuestos**: una tabla con cada archivo marcado "(upstream)" en
    esta lista: el archivo, la función o zona tocada, el motivo, y qué revisar
    cuando upstream lo cambie. Incluye el procedimiento de actualización:
    1.  `git fetch upstream` y `git merge upstream/main`.
    2.  Revisar cada archivo de la tabla.
    3.  **Comprobar la garantía:** que la versión vigente de `postWorkflow` llame
        a `getPostsList` después del `sleep` y que, si recibe `[]`, termine sin
        publicar. Si upstream agrega una versión nueva del workflow, repetir la
        comprobación en esa versión.
    4.  Comprobar que siguen existiendo `createPost`, `changeDate`,
        `changePostStatus` y `deletePost` en `posts.service.ts`, y las dos
        fuentes de plugs.
    5.  Buscar con `grep -rn "'QUEUE'"` en `libraries/` y `apps/`, y revisar cada
        resultado, incluidos los operadores ternarios. Un camino nuevo no
        publica sin aprobación, pero conviene cubrirlo para evitar
        `BLOCKED_AT_PUBLISH`.
    6.  Comparar las reglas de la huella con `updateMedia`
        (`posts.service.ts:506-611`).
    7.  Comparar la condición de suplantación de `approvals.controller.ts` con
        `auth.middleware.ts:60-61`.
    8.  Ejecutar `pnpm test:fork`.

    La tabla incluye tres filas para las reglas copiadas de upstream: las reglas
    de `updateMedia` dentro de `fingerprintsFromDb`, `isAllowedMediaPath`
    (movida al archivo 2b) y la condición de suplantación.

##### 51. `docs/fork/runbook.md` (Create)

*   **Cambios propuestos**:
    *   instalación en el VPS: variables, la app de Meta, la app de LinkedIn,
        el correo y la creación de los 4 usuarios con sus roles;
    *   operación: métricas, qué hacer ante un `BLOCKED_AT_PUBLISH` o un
        `RECONCILED`, y cómo leer el historial;
    *   registro de imágenes: dónde se publica `${FORK_IMAGE}` y cómo hacer
        `docker login`;
    *   vuelta atrás: `APPROVALS_ENABLED=false`; y, para quitar las tablas,
        borrar el bloque `FORK` de `schema.prisma` y ejecutar `db push` con
        `--accept-data-loss` después de respaldar la base;
    *   la obligación de la licencia AGPL: publicar el código fuente del fork
        para quien use la plataforma por la red.

#### G. Pruebas

Todas las pruebas usan el helper del archivo 55b. Cada prueba indica qué se
observa.

##### 52. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   **Huella (`fingerprintsFromDb`):**
        *   cambiar el texto, un archivo, su `alt`, su `thumbnail`, el retraso o
            los ajustes cambia el hash;
        *   cambiar `publishDate`, `releaseURL`, las etiquetas, el `path` de un
            archivo de la biblioteca o la fila de `Media` (su `alt`, su
            `deletedAt`) no lo cambia;
        *   una ruta local con el prefijo `UPLOAD_DIRECTORY` da el mismo hash
            que sin él; un archivo sin `id` de biblioteca con otro `path` da
            otro hash;
        *   `delay` ausente y `delay = 0` dan el mismo hash, y también
            `settings` con y sin claves vacías.
    *   **`isPublishAllowed`:**
        *   devuelve `true` con `APPROVALS_ENABLED=false`;
        *   devuelve `false` sin `PostApproval`, en cada etapa distinta de
            `APPROVED`, y con una huella distinta (en ese caso registra
            `BLOCKED_AT_PUBLISH` con `fingerprint_drift`);
        *   devuelve `true` en un lote `APPROVED` con la misma huella.
    *   **`typeForSave`:**
        *   `schedule` y `now` pasan a `draft`, `update` y `draft` se
            conservan, y un canal en `PUBLISHED` pasa a `update`;
        *   `republish: true` sobre un canal en `PUBLISHED` lanza `400`, y se
            ignora en los demás;
        *   `inter` sale `undefined`.
        *   **Implementado:** `schedule` con fecha pasada no lanza `400` en
            `typeForSave`. El canal se guarda como `draft` y `afterSave`
            registra `BLOCKED` con `reason: 'past_date'` (ver archivo 4).
    *   **`afterSave`:**
        *   crea `PostApproval` con `CREATED` (actor, rol y huellas) en el
            primer guardado;
        *   un lote `APPROVED` sin cambios y con `schedule` devuelve sus posts
            raíz en `toQueue`, menos los que están en `PUBLISHED`;
        *   un lote `APPROVED` con un canal cambiado pasa a `IN_REVIEW`, borra
            `approvedFingerprints`, registra `CONTENT_EDITED` y
            `RESET_BY_EDIT`, pasa a `DRAFT` los demás canales y devuelve
            `toQueue` vacío;
        *   una edición en `IN_PRODUCTION` registra `CONTENT_EDITED` sin cambiar
            la etapa;
        *   si `transition` devuelve `false`, relee y reintenta una vez;
        *   un cuerpo con canales de dos lotes procesa cada lote por separado;
        *   con `APPROVALS_ENABLED=false`, devuelve `toQueue` vacío y no crea
            filas.
    *   **`beforeChangeDate` y `afterChangeDate`:**
        *   `update` sobre un post en `QUEUE` devuelve `schedule`, y sobre uno
            en `PUBLISHED` devuelve `update`;
        *   `schedule` sobre un post en `ERROR` de un lote `IN_REVIEW` devuelve
            `update` y deja el post en `DRAFT`;
        *   las fechas pasadas lanzan `400`;
        *   `afterChangeDate` recalcula `earliestPublishDate` con la fecha nueva
            y borra las marcas de aviso cuando todas las fechas son futuras.
    *   **`beforeChangePostStatus`:** `schedule` sin aprobación lanza "Este post
        necesita aprobación final"; con fecha pasada lanza "La fecha de
        publicación ya pasó"; sobre `PUBLISHED` lanza el primero; `draft`
        siempre pasa.
    *   **`beforeDeletePost` y `afterDeletePost`:** borrar un canal en `ERROR` de
        un lote `APPROVED` registra `CHANNEL_DISCARDED` y no reinicia; borrar un
        canal sano lo reinicia, con huellas que ya no incluyen ese canal, y
        devuelve los demás en `toDraft`; si el borrado de upstream falla, no
        queda ningún evento.
    *   **`evaluatePublish`:** no escribe eventos ni métricas.
    *   **`updateEarliestPublishDate`:** editar el contenido dentro de las 48 h
        sin mover la fecha no borra `warned48At`.

##### 52c. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.notify.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   un segundo `RESET_BY_EDIT` del mismo lote antes de 15 minutos no envía
        aviso; después de 15 minutos sí;
    *   ningún `text` ni `html` contiene el contenido del post ni el de un
        comentario;
    *   cada plantilla llega a los destinatarios de su fila.

##### 52b. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.policy.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   cada acción exige su rol;
    *   quien registró `CREATED` no puede forzar desde `IN_PRODUCTION`;
    *   un Reviewer que editó en `IN_PRODUCTION`, antes del envío, no puede
        aprobar;
    *   el creador no puede aprobar aunque otra persona haya reenviado el lote;
    *   quien hizo `REVIEW_APPROVED` no puede dar la aprobación final;
    *   `actorRoleFor` devuelve el rol que exige la acción, `CREATOR` o `MEMBER`
        en las ediciones, y `SYSTEM` sin usuario.

##### 53. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   una prueba por cada fila de la tabla de transiciones, que comprueba la
        etapa final y los eventos escritos;
    *   una `version` vieja responde `409` en cada acción;
    *   rechazar o marcar un problema sin comentario falla, y con comentario
        guardan `commentId` y `reason`;
    *   forzar sin motivo falla; forzar un lote con fecha pasada mueve la fecha
        a ahora más un minuto y lo programa;
    *   `finalApprove` con 3 lotes, uno inválido, devuelve 2 aprobados y 1 con
        error; si `changePostStatus` falla en el segundo canal, el lote vuelve a
        `AWAITING_FINAL` y los canales ya programados pasan a `DRAFT`;
    *   `submit` sin brief y sin `quickTopic` falla; con `quickTopic` crea un
        brief con `quickBrief = true`; un canal inválido según `validatePosts`
        lo rechaza;
    *   `markProblem` crea un brief de corrección;
    *   `linkBrief` fuera de `IN_PRODUCTION` y `CHANGES_REQUESTED` falla;
    *   `setRoles` con un usuario de otra organización responde `404`;
    *   `getPreview` no devuelve `token` ni `refreshToken` de la integración.

##### 53b. `libraries/nestjs-libraries/src/database/prisma/approvals/briefs.service.spec.ts` (Create)

*   **Cambios propuestos**: solo el Technical Writer crea, edita y cancela; quien
    creó un brief rápido puede editarlo.

##### 53c. `apps/backend/src/api/routes/approvals.controller.approvals.spec.ts` (Create)

*   **Cambios propuestos**:
    *   con `isSuperAdmin` y la cookie o el header `impersonate`, cada ruta
        `POST` o `PUT` responde `403`;
    *   un usuario normal con una cookie `impersonate` vieja no recibe `403`.

##### 54. `libraries/nestjs-libraries/src/database/prisma/approvals/approval.sweep.service.spec.ts` (Create)

*   **Cambios propuestos**:
    *   con `APPROVALS_ENABLED=false`, `run` y `reconcile` no cambian nada;
    *   cada fila de la tabla de la tarea de mantenimiento, por separado (1 a
        5e), con la acción, el evento y el aviso esperados;
    *   `ERROR 'No Post'` en un lote `APPROVED` con `fingerprint_drift` vuelve a
        `IN_REVIEW` y avisa a los Monthly Reviewer, no a los ADMIN;
    *   un lote con un canal en `ERROR` no pasa a `PUBLISHED` hasta que se
        reintenta o se descarta;
    *   `reconcile({ startup: true })` registra `reason: 'startup'` y no avisa;
    *   ejecutar `run` dos veces seguidas no duplica eventos ni correos;
    *   si un paso falla, los demás se ejecutan igual.

##### 55. `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.approvals.spec.ts` (Create)

*   **Cambios propuestos**: una prueba por cada fila de la
    [tabla de caminos](#cómo-cada-camino-pasa-por-el-punto-de-control). Usan
    `PostsService` con el repositorio y Temporal simulados.
    *   **Editor, API, MCP:** `createPost` con `schedule` o `now` sobre un lote
        no aprobado guarda `DRAFT`, llama a `startWorkflow` con `DRAFT` y no lo
        llama con `QUEUE`.
    *   **Lote aprobado sin cambios:** `createPost` con `schedule` termina con
        los posts raíz en `QUEUE` y un `startWorkflow` con `QUEUE` por cada uno.
    *   **Reinicio de un lote de 3 canales aprobado (Blocker B1):** cambiar un
        canal llama a `startWorkflow` con `DRAFT` para los 3, y ningún post
        termina en `ERROR`.
    *   **Sin carrera:** en un lote aprobado sin cambios, el `startWorkflow` con
        `DRAFT` de cada canal termina antes del `startWorkflow` con `QUEUE`.
    *   **Lote mixto:** en un lote aprobado con un canal en `PUBLISHED`,
        `createPost` con `schedule` guarda ese canal con `update` y programa los
        demás.
    *   **`updatePostSettings` sobre un lote de 3 canales aprobado:** cambiar un
        ajuste de un canal reinicia el lote, pasa los otros dos a `DRAFT` y
        llama a `startWorkflow` con `DRAFT` para cada uno.
    *   **Fallo a mitad del bucle:** si el segundo `createOrUpdatePost` lanza
        un error, el `finally` llama a `afterSave` y ningún post raíz queda en
        `QUEUE`.
    *   **Calendario:** `changeDate(action: 'schedule', republish: true)` sobre
        un lote `APPROVED` en `QUEUE` deja el post en `QUEUE` y reinicia el
        workflow con la fecha nueva.
    *   **Republicar en dos pasos:** en un canal `PUBLISHED`,
        `changeDate(action: 'update')` con una fecha futura y después
        `changePostStatus('schedule')` responde `400`.
    *   **API pública:** `changePostStatus('schedule')` sin aprobación responde
        `400`.
    *   **Plugs:** `checkInternalPlug` y `checkPlugs` devuelven `[]`.
    *   **Posts repetidos:** `createPost` con `inter = 7` guarda
        `intervalInDays = null`.
    *   **Autopost:** crea `DRAFT` y un `PostApproval` en `IN_PRODUCTION`.
    *   **Organización sin `PostApproval`:** la tarea de mantenimiento la recorre
        y aplica los pasos 5d y 5b (en el archivo 54).

##### 55c. `apps/orchestrator/src/activities/post.activity.approvals.spec.ts` (Create)

*   **Cambios propuestos** (fase 2, con el helper 55b): `getPostsList` devuelve
    `[]` para un post de un lote no aprobado, registra `BLOCKED_AT_PUBLISH`, y
    devuelve la lista normal para uno aprobado o con `APPROVALS_ENABLED=false`.

##### 55b. `libraries/nestjs-libraries/src/database/prisma/approvals/test/approvals.test.helpers.ts` (Create)

*   **Cambios propuestos**:
    *   conexión a la base de prueba (Postgres real con `prisma db push`) y
        limpieza de las tablas entre pruebas;
    *   un fake de `TemporalService.client` con `jest-mock-extended`
        (`getRawClient().workflow.list/start`, `getWorkflowHandle().describe()`
        con `status.name` y `terminate`), que registra cada llamada;
    *   un fake de `NotificationService` que guarda los avisos;
    *   un `Test.createTestingModule` base con los servicios del fork que existan
        en la fase actual y `PostsService` con su `PostsRepository` real. El
        helper crece en cada fase.
    *   **Implementado (fase 2):** la base de prueba se toma de
        `FORK_TEST_DATABASE_URL` (por defecto
        `postgresql://postgres:test@127.0.0.1:5440/postiz_fork_test`) y las
        pruebas se niegan a correr si el nombre de la base no contiene `test`.
        Un `globalSetup` ejecuta `prisma db push` una vez por corrida, y las
        pruebas corren en serie (`maxWorkers: 1`). `jest.fork.config.ts`
        reemplaza, solo en las pruebas, `IntegrationManager`, `UploadFactory`,
        `file-type` e `isomorphic-dompurify` por stubs en
        `approvals/test/stubs/`: cargan paquetes solo ESM que Jest no puede
        leer, y las pruebas del fork no publican ni guardan archivos.

### Verification Plan

*   **Compilación**: `pnpm build` desde la raíz, y `pnpm prisma-db-push` sobre
    una base vacía.
*   **Pruebas unitarias**: `pnpm test:fork`, con el umbral de cobertura del
    archivo 48.
*   **Análisis estático**: `pnpm lint:fork` (script nuevo del archivo 49), sin
    `eslint-disable-next-line` nuevos.
*   **Chequeo de esquema**: `node scripts/fork/check-schema-additive.mjs
    /tmp/upstream.prisma libraries/nestjs-libraries/src/database/prisma/schema.prisma`
    termina con código 0.
*   **Prueba de punta a punta** en un VPS de prueba con `docker compose up`:
    1.  Crear 4 usuarios y asignar los roles. Conectar una página de Facebook,
        una cuenta de Instagram y una página de LinkedIn de prueba.
    2.  Recorrer el CUJ 1 completo y confirmar que se publica en las 3 redes y
        que el historial muestra, en orden, `CREATED`, `LINKED_BRIEF`,
        `SUBMITTED`, `REVIEW_APPROVED`, `FINAL_APPROVED`, `PUBLISHED` y
        `VERIFIED`.
    3.  Recorrer los CUJ 2 a 7 y confirmar el resultado que describe el "Then"
        de cada uno.
    4.  Con la API key, ejecutar `POST /public/v1/posts` con `type: schedule` y
        `PUT /public/v1/posts/:id/status` con `schedule`. Confirmar que el post
        queda en `DRAFT` y que la segunda llamada responde `400`.
    5.  **Garantía al publicar:** desde la base, poner un post sin aprobar en
        `QUEUE` con fecha dentro de 2 minutos, e iniciar a mano
        `postWorkflowV112` con `postNow: true` desde la CLI de Temporal dentro
        del host. Confirmar que no se publica, que queda en
        `ERROR 'No Post'`, y que en 15 minutos o menos pasa a `DRAFT` con
        `BLOCKED_AT_PUBLISH` y un correo a los ADMIN.
    6.  Abrir `/p/<id>` sin sesión y confirmar que redirige al login.
    7.  Desde otra máquina, confirmar que los puertos 7233 y 8080 del VPS no
        responden.
    8.  Recrear los contenedores con `docker compose down && docker compose up`
        y confirmar que los posts aprobados siguen en `QUEUE` con un workflow
        `Running`.
    9.  Poner `APPROVALS_ENABLED=false`, reiniciar, programar un post y
        confirmar que se publica como en upstream y que la tarea de
        mantenimiento no lo toca.
    10. Medir el tiempo de un guardado de un lote de 3 canales (máximo 50 ms
        más que upstream) y de `getPostsList` (máximo 20 ms más).
    11. Editar un lote aprobado de 2 canales y confirmar que ninguno termina en
        `ERROR` ni genera un correo a los ADMIN.

--------------------------------------------------------------------------------

*Drafted with EGM*
