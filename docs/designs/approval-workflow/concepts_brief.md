# Flujo de aprobación con 4 roles sobre Postiz

* **Autor:** onix.ortiz.cruz@gmail.com
* **Fecha:** 2026-10-28
* **Base:** fork de https://github.com/gitroomhq/postiz-app (AGPL-3.0), alojado en un servidor propio con Docker

Las rutas de archivos son relativas a la raíz del repo `postiz-app/`.

## Resumen

Un equipo interno quiere su propia plataforma de redes sociales construida sobre
Postiz: crear posts, programarlos, publicarlos en las redes que Postiz soporta y
revisar las analíticas.

Lo que Postiz no trae es un **control de aprobación**. Hoy cualquier miembro de
la organización programa un post y este sale solo a su hora. El cambio que
proponemos agrega cuatro roles de trabajo y una cadena de aprobación. Ningún post
llega a una red sin la aprobación final.

| Rol | Qué hace |
|---|---|
| **Technical Writer** | Define el tema y el texto. Después de publicar, verifica que el post salió bien en la red. |
| **Creator** | Arma el post: texto final, media y canales. Lo envía a revisión. |
| **Reviewer** | Revisa el post. Lo aprueba o lo devuelve con comentario. |
| **Monthly Reviewer** | Es el jefe. Da la aprobación final; sin ella no se publica nada. Revisa las analíticas cada mes. |

Reglas acordadas en la conversación:

* Todos ven y editan todo, pero cada paso de aprobación solo lo da el rol indicado.
* Si alguien edita un post ya aprobado, el post vuelve a revisión.
* Un rechazo devuelve el post al Creator con un comentario obligatorio.
* Si llega la hora programada sin aprobación final, el post no se publica. Queda
  marcado como vencido y se avisa al equipo.
* El flujo es igual para todas las redes. En la primera versión solo se
  configuran Instagram, Facebook y LinkedIn.
* Las analíticas son las que Postiz ya trae; no se construye un sistema de
  calificación.

## Análisis

Seis revisores independientes leyeron el código. Estas son sus conclusiones,
agrupadas por tema.

### 1. No hay nada de aprobación que reutilizar

Postiz no tiene ningún flujo de aprobación.

* El campo `Post.approvedSubmitForOrder` es un resto del marketplace y no se usa.
* `Customer` solo agrupa canales para agencias.
* `Sets` son plantillas de post.

Sí se puede reutilizar lo siguiente:

* los comentarios (`Comments`, con respuestas, anclas al texto y fecha de resuelto);
* las notificaciones;
* el `releaseURL` que se guarda al publicar;
* el patrón de la tarea programada que revisa cada hora los posts que no salieron.

### 2. El bloqueo tiene que vivir en la capa de servicio, no en la pantalla

Hay muchas formas de poner un post en `QUEUE` (programado):

* el editor web;
* arrastrar el post en el calendario (`changeDate`);
* la API pública, incluida `PUT /public/v1/posts/:id/status`;
* el SDK;
* la herramienta MCP o agente (`integration.schedule.post.ts`);
* "Post Now".

Todas pasan por tres métodos de `posts.service.ts`: `createPost`, `changeDate` y
`changePostStatus`. Bloquear solo los botones no sirve.

El código tiene además cuatro huecos que dejarían salir un post sin aprobación:

* **El workflow revisa el estado solo antes de dormir.**
  `post.workflow.v1.1.2.ts:161` revisa el estado y luego espera hasta la hora de
  publicar. Al despertar (línea 182) publica sin volver a revisar. Hay ediciones
  que no reinician el workflow: los guardados de tipo `update`,
  `updatePostSettings` (que usan la API pública y MCP) y `changeDate` con
  `action='update'`. Con ellas, un post aprobado y editado después se publicaría
  con el texto nuevo.
* **La tarea de cada hora republica cualquier `QUEUE`.** `missingPostWorkflow`
  vuelve a lanzar todo post en `QUEUE` de los últimos 2 días. Si un post sin
  aprobar llega a `QUEUE` aunque sea un momento, se publica.
* **Los posts repetidos (`intervalInDays`) se saltan la revisión de estado.** Una
  sola aprobación autorizaría una serie sin fin de posts.
* **Los "plugs" publican texto que nadie revisó.** Son los reposts desde otras
  cuentas y la respuesta automática al llegar a cierto número de likes.

**Forma recomendada:**

1. **Regla.** Un post solo puede estar en `QUEUE` si su versión actual tiene
   aprobación final. Mientras no la tenga se queda en `DRAFT`. Así no corre
   ningún workflow y la tarea de cada hora lo ignora.
2. **Un solo punto de control.** Una función decide qué estado produce cada
   guardado y si se inicia o se cancela el workflow. La llaman todos los caminos.
   El patrón ya existe en `guardAgainstRepublish` (`posts.service.ts:1122`).
3. **Una huella del contenido.** Al aprobar, se guarda un hash del texto, la
   media y los ajustes del post y sus hilos. Si un guardado cambia la huella, el
   post vuelve a `DRAFT`, pasa a revisión y se cancela su workflow. No sirve
   `updatedAt`, porque cambia por cualquier motivo.
4. **Aprobar tarde no publica de golpe.** Si la hora ya pasó, la aprobación final
   se rechaza hasta que se ponga una fecha nueva. Sin esto, el workflow espera
   0 ms y publica en el acto.

### 3. Los roles de Postiz no protegen nada en un servidor propio

* Si no está configurado Stripe, `PermissionsService.check` le da todos los
  permisos a cualquiera (`permissions.service.ts:50-63`, verificado). El
  decorador `@CheckPolicies` no puede hacer cumplir "solo el Reviewer aprueba".
  La revisión de rol tiene que escribirse a mano en la capa de servicio.
* **No conviene agregar los 4 roles al enum `Role`.** Ese enum es una escalera de
  privilegios con niveles numéricos. Las invitaciones solo aceptan `USER` o
  `ADMIN`, y el menú superior filtra por rol. Además, una persona tiene un solo
  rol por organización, así que no podría ser `ADMIN` y Monthly Reviewer a la
  vez. Va mejor una tabla aparte de asignaciones, donde una persona puede tener
  varios roles de trabajo.
* **La API pública, el SDK y MCP no saben quién es la persona.** Una llamada con
  API key entra como `SUPERADMIN` y sin usuario (`public.auth.middleware.ts`).
  Esos caminos no pueden dar un paso de aprobación que dependa de una persona.

### 4. Qué se aprueba: el "post" es ambiguo en Postiz

* `Post.group` es la cadena de un solo canal: el post raíz y sus hilos. Lo que
  une varias redes es `batchId`, y puede venir vacío.
* Cada guardado desde el panel le da al grupo un UUID nuevo y borra de forma
  lógica las filas viejas. Una aprobación o un comentario pegado a esa fila
  quedaría colgado de una fila borrada.
* Recomendación: la aprobación tiene su propio ID y apunta al post raíz, y ese
  puntero se actualiza en cada guardado. En la pantalla se aprueba por lote
  (todas las redes de una campaña) para no aprobar lo mismo una vez por red.

### 5. Estados, datos e historial

* **No conviene agregar valores al enum `State`.** Unas 35 comparaciones en 17
  archivos listan los estados a mano. Los posts con estados nuevos
  desaparecerían de listas, API y MCP. Además, `startWorkflow` marcaría como
  `ERROR` cualquier estado que no sea `DRAFT`.
* **Recomendación:** `State` queda solo para publicar. La etapa del flujo va en
  una tabla nueva `PostApproval`, con estas etapas: tema, en producción, en
  revisión, esperando aprobación final, aprobado, con cambios pedidos y vencido.
  La verificación se guarda como `verifiedAt`/`verifiedBy`.
* **Historial.** Una tabla nueva `PostApprovalEvent` donde solo se agregan filas,
  nunca se editan. Cada fila guarda quién, con qué rol, qué acción, desde dónde
  (web, API o MCP), la huella, una copia del contenido y el comentario. Se
  escribe en la misma transacción que el cambio.
* **Comentarios de rechazo.** El rechazo crea un evento y un comentario, y el
  evento apunta al comentario. Así una charla normal no se confunde con el
  motivo del rechazo. Nunca se aprueba desde la página pública de preview.

### 6. Vencimiento y avisos

* Con la regla recomendada, un post sin aprobar nunca entra al workflow. Por
  eso nada lo vigila a su hora. Hace falta una tarea nueva de vencimiento que
  copie el patrón de `missingPostWorkflow` y se registre en
  `infinite.workflow.register.ts`. Si corre cada hora, el aviso puede llegar
  hasta 59 minutos tarde.
* Conviene avisar antes de vencer (por ejemplo, a 48 h y a 24 h), no solo cuando
  ya venció.
* **Los avisos no pueden dirigirse a una persona.** `Notifications` no tiene
  destinatario: el aviso le llega a toda la organización. El correo solo
  funciona si se configura `EMAIL_PROVIDER`. `sendEmail(to, ...)` sí puede
  escribirle a una persona.
* Hoy `startWorkflow` se traga los errores. Hay que registrar en logs y métricas
  los bloqueos, los vencimientos y las aprobaciones.

### 7. Verificación y reintentos

* La verificación se puede automatizar casi entera. Al publicar se guarda el
  `releaseURL`, y ya existen webhooks y un modal para el link faltante. Queda
  una firma manual del Technical Writer para problemas visuales, como recortes o
  formato.
* Si la verificación falla, se crea un borrador de corrección enlazado. No se
  puede prometer editar ni borrar en la red: la mayoría de las redes no lo
  permiten.
* Si un post aprobado falla y su huella no cambió, se puede reintentar sin
  aprobarlo de nuevo.

### 8. Migración, despliegue y pruebas

* **Sin historial de migraciones.** El esquema se aplica con `prisma db push` al
  arrancar. Agregar tablas es seguro. Quitarlas después hace fallar el arranque.
  Las tablas del fork van en un bloque marcado al final de `schema.prisma`.
* **Posts en `QUEUE` el día del cambio.** Sus workflows ya pasaron la revisión
  de estado y saldrían sin aprobación. Hay que decidir si se dan por aprobados o
  si un script los regresa a revisión.
* **Docker.**
  * `docker-compose.yaml` baja la imagen oficial, no la del fork.
  * `var/docker/docker-build.sh` está roto.
  * Temporal necesita Elasticsearch y usa volúmenes anónimos: si se recrean los
    contenedores, se pierden los workflows programados.
  * No hay que exponer la UI de Temporal (puerto 8080) a internet.
* **No hay pruebas en el repo.** El plan tiene que montar la base de pruebas:
  una prueba por cada fila de la tabla de transiciones y una por cada camino
  alternativo de publicación.
* **Costo del fork.** `posts.service.ts` (1787 líneas) y `posts.repository.ts`
  son los archivos que más cambia upstream. El código nuevo debe ir en carpetas
  propias, y una lista `FORK_TOUCHPOINTS` registra cada archivo upstream tocado.

### 9. Datos de la idea que hay que corregir

* El repo es un workspace de pnpm, no Nx.
* Hay 36 integraciones de redes, no 38.
* **Solo 12 de las 36 redes tienen analíticas:** YouTube, X, TikTok, TikTok
  Business, Threads, Pinterest, LinkedIn Page, Instagram, Instagram Standalone,
  GMB, Facebook y Dribbble. Las otras 24 no tienen.

### 10. Experiencia de uso

* **"Monthly Reviewer" con aprobación post por post** convierte al jefe en un
  cuello de botella diario, y los vencimientos se vuelven frecuentes. Conviene
  una vista para aprobar varios a la vez, y quizás otro nombre.
* **"Borrador" choca con el `DRAFT` de Postiz.** Un post rechazado se vería igual
  que uno nunca enviado.
* **Los botones del editor confundirían.** "Schedule" y "Post Now" en realidad
  significarían "enviar a revisión" (`manage.modal.tsx`).
* **Cada rol necesita su bandeja de "pendiente para mí"**, colores por etapa en
  el calendario y una línea de tiempo en el post.
* **La página pública de preview no pide login.** Quien tenga el ID de un post
  puede leer texto no aprobado.
* **No hay campo de "tema".** Hay que decidir dónde guarda el Technical Writer el
  tema del contenido.

## Metas vs. no metas

* **Metas:**
  * 4 roles de trabajo asignables a personas, en una tabla aparte del `Role` de
    Postiz.
  * Cadena Writer → Creator → Reviewer → Monthly Reviewer que bloquea la
    publicación en todos los caminos.
  * Volver a revisión al cambiar la huella del contenido.
  * Rechazo con comentario obligatorio.
  * Vencimiento con aviso.
  * Historial de aprobaciones.
  * Verificación después de publicar.
  * Despliegue en un servidor propio con Docker.
* **No metas:**
  * Un sistema propio de calificación o analíticas.
  * Configurar y probar redes distintas de Instagram, Facebook y LinkedIn en la
    primera versión.
  * Posts repetidos (`intervalInDays`) y plugs en la primera versión.
  * Publicar desde la API pública, el SDK o MCP sin pasar por el flujo.
  * Editar o borrar posts ya publicados en la red.
  * Varias organizaciones o clientes externos (es un solo equipo interno).
  * Uso comercial o reventa (lo condiciona la AGPL).

## Alternativas descartadas

* **Agregar los 4 roles al enum `Role`.** Rompe los niveles numéricos, las
  invitaciones, el filtro del menú y la lógica de dueño. Además, una persona no
  podría tener dos roles.
* **Agregar estados de aprobación al enum `State`.** Toca unos 35 lugares, hace
  desaparecer posts de listas, API y MCP, y `startWorkflow` los convierte en
  `ERROR`.
* **Bloquear solo en la pantalla o en los controladores.** La API pública, el
  SDK, MCP, la tarea de cada hora, los posts repetidos y las ediciones tipo
  `update` lo esquivan.
* **Confiar en `@CheckPolicies` (CASL).** En un servidor propio sin Stripe no
  bloquea nada.
* **Editar `post.workflow.v1.1.2.ts`.** El `CLAUDE.md` del repo lo prohíbe y
  rompería los workflows que ya están corriendo.
* **Bloquear solo dentro de la actividad que publica.** Un error simple se
  reintenta 5 veces y muestra un aviso falso. Sirve solo como red de seguridad.
* **Llevar la aprobación en señales de Temporal.** Los workflows se cancelan y se
  reinician en cada guardado, y las señales se pierden. La base de datos tiene
  que ser la fuente de verdad.
* **Columnas de aprobación en la tabla `Post`.** Es el modelo que más cambia
  upstream, la fila se reescribe en cada guardado y no queda historial.
* **Usar `group` como llave de la aprobación.** Cambia en cada guardado.
* **Reutilizar `approvedSubmitForOrder` o `Customer`.** Uno es un campo muerto y
  el otro solo agrupa canales.
* **Un middleware de Prisma que bloquee `QUEUE` en todo el sistema.** Nadie que
  lea el repositorio lo ve, y sorprende al orquestador. Como mucho, red de
  seguridad.
* **Aprobación por canal como opción por defecto.** Multiplica los clics del jefe
  y crea estados parciales confusos.
* **Reiniciar todo desde el principio en cada guardado.** Corregir una letra
  borraría todas las aprobaciones.
* **Notion o un Kanban al lado de Postiz sin cambios.** Nada hace cumplir el
  bloqueo. Sirve solo como prueba inicial.
* **Servicio aparte en lugar de fork.** Postiz quedaría sin cambios y un servicio
  pequeño manejaría las aprobaciones por la API pública. Se descartó porque
  cualquiera podría programar directo desde el editor de Postiz y saltarse el
  flujo.
* **Mantener las 36 redes activas.** Cada una exige su app de desarrollador y sus
  credenciales, y 24 no tienen analíticas. El equipo usa tres.
* **Aprobar el calendario del mes en un solo paso.** Los cambios a mitad de mes
  no pasarían por el jefe.
* **Apagar por completo la API pública, el SDK y MCP.** Se perdería la
  automatización externa. Basta con que solo puedan crear borradores.
* **Reiniciar la aprobación al mover la fecha.** Obligaría a aprobar de nuevo
  cada vez que se arrastra un post en el calendario.

## Decisiones tomadas y pendientes para `/egm-draft`

**Decididas en la conversación:**

1. Fork de Postiz alojado en un VPS propio con Docker.
2. Roles: Technical Writer, Creator, Reviewer y Monthly Reviewer (jefe,
   aprobación final).
3. Orden: Writer → Creator → Reviewer → Monthly Reviewer → programar y publicar →
   verificación del Writer.
4. Permisos: todos ven y editan todo; aprobar es solo del rol indicado; editar
   algo aprobado lo regresa a revisión.
5. Rechazo: vuelve al Creator con comentario obligatorio.
6. Vencido: no se publica, se marca y se avisa.
7. Redes: el flujo es el mismo para todas, pero en la primera versión solo se
   configuran y prueban **Instagram, Facebook y LinkedIn**. Esto reemplaza la
   decisión anterior de "todas las redes".
8. Analíticas: las de Postiz, revisadas cada mes por el Monthly Reviewer. Las
   tres redes elegidas las tienen; en LinkedIn solo las páginas, no los perfiles
   personales.
9. **Enfoque: fork con cambios aislados.** El código nuevo va en carpetas
   propias, con una lista `FORK_TOUCHPOINTS` de los archivos upstream tocados.
   Se descartó el servicio aparte porque no impide programar directo desde el
   editor.
10. **Unidad de aprobación:** el post con todas sus redes (el lote). El Monthly
    Reviewer tiene una bandeja para aprobar varios posts a la vez.
11. **Otras vías** (API pública, SDK, MCP/agente): solo crean o editan
    borradores, que entran al flujo. Los posts repetidos y los plugs se apagan en
    la primera versión.
12. **Qué reinicia la aprobación:** cambiar el texto, la media, los canales o los
    ajustes regresa el post al Reviewer. Mover solo la fecha a otra fecha futura
    no lo reinicia, pero queda en el historial. Mover a una fecha pasada se
    rechaza.
13. **Transición:** es una instalación nueva y arranca sin posts. Aun así se
    incluye un script que regresa a revisión cualquier post en `QUEUE` sin
    aprobación.
14. **Avisos:** correo directo a las personas del siguiente rol, además de la
    campanita. Avisos 48 h y 24 h antes de vencer. Hay que configurar
    `EMAIL_PROVIDER` en el VPS.
15. **Personas y roles:** un rol puede tener varias personas, y basta con que una
    apruebe. Una persona puede tener varios roles, pero no puede aprobar dos
    pasos seguidos del mismo post ni aprobar su propio trabajo. El suplente del
    jefe es otra persona con el rol Monthly Reviewer.
16. **Emergencia:** solo el Monthly Reviewer puede forzar una publicación, con un
    motivo obligatorio que queda en el historial y avisa al equipo. *La pregunta
    hablaba de "un ADMIN" y la opción elegida de "el Monthly Reviewer"; el
    borrador debe confirmar cuál.*
17. **Verificación:** el sistema confirma la publicación y guarda el link. El
    Technical Writer marca "verificado" o "tiene problema" en un plazo de 24 h.
    Un problema crea un borrador de corrección enlazado.
18. **Preview:** exige login de un miembro de la organización.

**Abiertas para `/egm-draft` (decisiones técnicas):**

1. **Red de seguridad al publicar.** ¿Una nueva versión del workflow (V113) que
   vuelva a revisar la aprobación al despertar? ¿O basta con la regla en la capa
   de servicio más una revisión en la actividad que publica?
2. **Migraciones.** ¿Seguir con `db push` o pasar el fork a `prisma migrate`?
3. **Dónde vive el "tema"** del Technical Writer: un campo en `PostApproval`, el
   primer comentario o una tabla de briefs.
4. **Expirado y reprogramado.** ¿Conserva las aprobaciones anteriores si el
   contenido no cambió, o vuelve a empezar desde el Reviewer?
5. **Lote parcial.** Si se edita una sola red de un lote aprobado, ¿se reinicia
   solo esa red o el lote entero?
6. **Nombres en pantalla** para no chocar con el `DRAFT` de Postiz ni con
   "preview" (por ejemplo, "Cambios pedidos" en lugar de "Borrador").
