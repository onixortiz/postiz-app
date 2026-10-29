# Runbook del fork: aprobación de posts

Guía de instalación y operación de la plataforma con la cadena de aprobación de
4 roles. El diseño completo está en
[docs/designs/approval-workflow.md](../designs/approval-workflow.md), y la
lista de archivos de upstream que cambia el fork, en
[FORK_TOUCHPOINTS.md](../../FORK_TOUCHPOINTS.md).

## Cómo funciona, en una página

| Rol | Qué hace |
|---|---|
| **Technical Writer** | Crea los temas (`/briefs`) con el texto base. Verifica cada post publicado o marca un problema. |
| **Creator** | Crea el post desde un tema ("Crear post desde este tema") y lo envía a revisión desde el panel de aprobación del editor. |
| **Reviewer** | Aprueba o pide cambios, con comentario. |
| **Monthly Reviewer** | Da la aprobación final, que programa el post. En una emergencia puede forzar la publicación, con motivo. |

*   Un post solo se publica si su lote está **Aprobado** y su contenido no
    cambió desde la aprobación. Lo comprueba el orquestador justo antes de
    publicar, sin importar desde dónde se guardó.
*   Cualquier cambio de contenido en un post aprobado lo devuelve a revisión.
    Mover la fecha a una fecha futura no.
*   Nadie aprueba ni fuerza un post que creó, envió o editó, y nadie aprueba dos
    etapas seguidas.
*   La bandeja `/approvals` ("Pendiente para mí") muestra lo que le toca a cada
    persona según sus roles.

## Instalación en el VPS

### 1. Imagen

El `docker-compose.yaml` del fork no usa la imagen de upstream, sino la del
fork:

```bash
docker login ghcr.io -u <usuario-de-github>
```

```bash
FORK_IMAGE=ghcr.io/<usuario-de-github>/postiz-app:approvals ./var/docker/docker-build.sh
```

Para `docker login` en `ghcr.io` se usa un token de GitHub con el permiso
`write:packages`. Si la imagen se publica como privada, el VPS también tiene
que hacer `docker login` antes de `docker compose pull`.

### 2. Variables

En el `environment` del servicio `postiz` de `docker-compose.yaml` (o en un
`.env` junto a él):

| Variable | Valor | Por qué |
|---|---|---|
| `FORK_IMAGE` | La imagen del paso 1 | `docker compose` no arranca sin ella |
| `APPROVALS_ENABLED` | `'true'` | Activa la cadena. La leen el backend y el orquestador |
| `RUN_CRON` | `'true'` | Arranca la tarea de mantenimiento cada 15 minutos y la conciliación al arrancar |
| `EMAIL_PROVIDER` y sus variables | `resend` con `RESEND_API_KEY`, o `nodemailer` con `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS` | Los correos a los revisores y a los ADMIN son la alerta principal. Sin correo, solo hay avisos dentro de la app y el log lo advierte al arrancar |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | El remitente | |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | App de Meta | Facebook |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | App de Meta | Instagram |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | App de LinkedIn | LinkedIn |
| `SENTRY_DSN` | Opcional | Métricas `approval_*` |
| `STRIPE_*` | **Vacías** | No se usa facturación |

### 3. Apps de las redes

*   **Meta (Facebook e Instagram):** una app en
    [developers.facebook.com](https://developers.facebook.com) con los productos
    de Facebook Login e Instagram. La URL de retorno es la de Postiz:
    `<FRONTEND_URL>/integrations/social/facebook` y
    `<FRONTEND_URL>/integrations/social/instagram`. Para publicar en páginas de
    otras personas, Meta pide la revisión de la app.
*   **LinkedIn:** una app en
    [linkedin.com/developers](https://www.linkedin.com/developers) con "Sign In
    with LinkedIn" y "Share on LinkedIn". La URL de retorno es
    `<FRONTEND_URL>/integrations/social/linkedin` para un perfil y
    `<FRONTEND_URL>/integrations/social/linkedin-page` para la página de la
    empresa (que además pide el producto "Community Management API").

Las rutas exactas pueden cambiar con Postiz. Si una conexión falla, revisa la
documentación de Postiz para ese proveedor.

### 4. Arranque

```bash
docker compose up -d
```

*   Postiz hace `prisma db push` al arrancar y crea las tablas del fork.
*   Los puertos de Temporal (7233 y 8080) solo escuchan en `127.0.0.1`. Para ver
    la UI de Temporal desde tu computadora, usa un túnel:

```bash
ssh -L 8080:127.0.0.1:8080 <usuario>@<vps>
```

*   Al arrancar, el backend hace una conciliación: los posts en `QUEUE` sin
    aprobación válida pasan a borrador. Es la instalación inicial: no hace falta
    otro script.

### 5. Usuarios y roles

1.  Crea la cuenta del ADMIN (la primera cuenta de la organización).
2.  Invita a las otras personas desde **Configuración > Equipo**.
3.  En la misma pantalla, en **Roles del flujo**, marca los roles de cada
    persona. Una persona puede tener varios.
4.  La pantalla avisa si hay menos de 2 Reviewer o menos de 2 Monthly Reviewer.
    Con uno solo de cada uno, sus propios posts no se pueden aprobar y todo
    espera cuando esa persona no está.

## Operación

### Avisos y correos

| Aviso | A quién | Qué hacer |
|---|---|---|
| Post para revisar / para aprobación final | Reviewer / Monthly Reviewer | Abrir la bandeja `/approvals` |
| Cambios pedidos | Quien lo envió | Corregir y volver a enviar |
| Vence en 48 h / 24 h | El rol de la etapa actual | Mover el post o aprobarlo |
| Venció sin aprobación | Todo el equipo | No se publicó. Mover el lote a una fecha futura en el calendario y seguir la cadena |
| Publicado, falta verificar | Technical Writer | Abrir los enlaces, verificar o marcar problema |
| Publicación forzada | Todo el equipo y, por correo, los ADMIN | Revisar el motivo en el historial |
| **Se impidió publicar sin aprobación** (`BLOCKED_AT_PUBLISH`) | ADMIN, o Monthly Reviewer si fue un cambio de contenido | Ver abajo |
| **Post sin aprobación desprogramado** (`RECONCILED`) | ADMIN | Ver abajo |

### Ante un `BLOCKED_AT_PUBLISH` o un `RECONCILED`

Ninguno de los dos publicó nada: el sistema detuvo el post y lo dejó en
borrador.

*   **Con `fingerprint_drift`:** el contenido de un post aprobado cambió por un
    camino que no avisó (por ejemplo, una reescritura automática de los
    archivos multimedia). El lote volvió a revisión: hay que aprobarlo otra vez.
*   **Con otro motivo (`stage`, `no_approval`, `not_queued`) o un `RECONCILED`
    que no es de `startup`:** algo intentó programar un post sin aprobación. Es
    una alerta.
    1.  Abre el post desde el aviso y mira su **Historial** en el panel de
        aprobación: quién lo creó, desde qué superficie (`WEB`, `API`, `MCP`) y
        cuándo.
    2.  Si fue la API pública, revisa quién tiene la API key de la organización.
    3.  Si no hay ninguna explicación, revisa los logs del backend (`RECONCILED
        post ...`, `blocked at publish: post ...`).

### Historial

El panel de aprobación del editor muestra cada evento del lote: la acción, la
persona, su rol, la superficie, la hora y el comentario o el motivo.

### Métricas (Sentry)

`approval_blocked`, `approval_blocked_at_publish`, `approval_reset`,
`approval_expired`, `approval_forced` y `approval_reconciled`. Las alertas
importantes son `approval_blocked_at_publish` (salvo `fingerprint_drift`) y
`approval_reconciled`.

### Tarea de mantenimiento

`approvalSweepWorkflow` corre cada 15 minutos en Temporal, con el ID fijo
`approval-sweep-workflow`. Si no aparece como `Running` en la UI de Temporal,
revisa que el backend tenga `RUN_CRON=true` y reinícialo.

## Vuelta atrás

*   **Apagar la cadena:** `APPROVALS_ENABLED=false` y reiniciar. La plataforma
    se comporta como Postiz de upstream. Las tablas del fork se quedan, sin
    usarse, y al volver a activarla la conciliación adopta los posts creados
    mientras tanto.
*   **Quitar las tablas:** primero un respaldo de la base:

```bash
docker exec postiz-postgres pg_dump -U postiz-user postiz-db-local > respaldo.sql
```

    Después se borra el bloque `FORK: approvals` y las relaciones marcadas
    `// FORK` de `schema.prisma`, y se ejecuta `prisma db push
    --accept-data-loss`.

## Pruebas del fork

Necesitan un Postgres cuyo nombre de base contenga `test` (las pruebas se
niegan a correr si no):

```bash
docker run -d --rm --name postiz-fork-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postiz_fork_test -p 127.0.0.1:5440:5432 postgres:17-alpine
```

```bash
pnpm test:fork
```

```bash
pnpm lint:fork
```

Con otra base, define `FORK_TEST_DATABASE_URL`. En CI corre
`.github/workflows/fork-checks.yml`, que además comprueba con
`scripts/fork/check-schema-additive.mjs` que el esquema solo agrega cosas
respecto a upstream. Los workflows de upstream (`build.yml`,
`build-containers.yml`, `deploy-aws.yml`, etc.) se desactivan en la
configuración de GitHub Actions del fork.

## Licencia

Postiz es AGPL-3.0. Quien use la plataforma por la red tiene derecho a recibir
el código fuente del fork, con estos cambios. Mantén el repositorio del fork
accesible (por ejemplo, público en GitHub) o entrega el código a quien lo pida.
