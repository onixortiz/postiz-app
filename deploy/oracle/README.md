# Instalación en Oracle Cloud (gratis) con Tailscale Funnel

Todo corre en una sola máquina virtual gratis de Oracle. La máquina no abre
ningún puerto a internet salvo SSH: el contenedor `tailscale` se conecta
hacia afuera y Tailscale Funnel publica la app con HTTPS en una dirección fija
`https://alpine.<tu-tailnet>.ts.net`, sin necesidad de dominio propio.

```
navegador ──HTTPS──▶ Tailscale Funnel (alpine.tailXXXX.ts.net)
                        │  conexión que abre la máquina, hacia afuera
                        ▼
               VM Oracle ─ tailscale ─▶ postiz:5000 (nginx: / y /api)
                                       ├─ postgres, redis
                                       └─ temporal (+ su postgres y elasticsearch)
```

La pantalla de login queda pública en esa dirección. La protegen la
contraseña de cada persona y el registro cerrado (paso 5): ciérralo en cuanto
el equipo haya entrado.

Lo que hace falta antes de empezar:

- Una cuenta de Oracle Cloud (pide tarjeta, no cobra dentro de "Always Free").
- Una cuenta gratis de Tailscale (https://login.tailscale.com, con Google,
  Microsoft o GitHub).

## 1. Crear la máquina en Oracle

1.  En la consola de Oracle: **Compute → Instances → Create instance**.
2.  **Image:** Canonical Ubuntu 24.04.
3.  **Shape:** Ampere, `VM.Standard.A1.Flex`, **4 OCPU y 24 GB** de memoria.
    Si sale "Out of capacity", prueba otro "Availability domain" o vuelve a
    intentar más tarde.
4.  **Boot volume:** 100 GB (el plan gratis cubre hasta 200 GB en total).
5.  **SSH keys:** sube tu llave pública (`~/.ssh/id_ed25519.pub`) o descarga
    la que genera Oracle.
6.  Crea la instancia y anota su IP pública.
7.  No abras más puertos: la "security list" por defecto solo deja entrar el
    22 (SSH). Si quieres, limita ese 22 a tu IP.
8.  Recomendado: **Billing → Upgrade to Pay As You Go**. Sigue siendo gratis
    dentro de los límites y evita que Oracle recupere la máquina si pasa
    varios días con poco uso.

## 2. Preparar Tailscale

En el panel de Tailscale (https://login.tailscale.com/admin):

1.  **DNS:** anota el **Tailnet DNS name** (algo como `tail1234.ts.net`) y
    activa **MagicDNS** y **HTTPS Certificates** si no están activos.
2.  **Access controls:** comprueba que la política tenga el permiso de
    Funnel. Las cuentas nuevas lo traen; si no, agrega:

    ```json
    "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
    ```

3.  **Settings → Keys → Generate auth key**: sin marcar "Reusable" ni
    "Ephemeral". Copia la clave (`tskey-auth-...`). Solo sirve para el primer
    arranque.

## 3. Después del primer arranque

Cuando termines el paso 4 y la máquina aparezca en **Machines** como
`alpine`, abre su menú y
elige **Disable key expiry**. Si no, Tailscale la desconecta a los 180 días y
la app deja de estar en línea.

## 4. Instalar en la máquina

```bash
ssh ubuntu@<ip-de-la-vm>
```

```bash
git clone -b feat/approval-workflow https://github.com/onixortiz/postiz-app.git
```

```bash
cd postiz-app && sudo bash deploy/oracle/setup.sh
```

El script:

- instala Docker,
- pide el Tailnet DNS name y la auth key de Tailscale, y genera
  `deploy/oracle/.env` con secretos nuevos (`JWT_SECRET` y las claves de las
  bases de datos),
- programa el backup diario a las 03:30,
- construye la imagen (la primera vez tarda de 15 a 25 minutos) y arranca
  todo.

Para ver el arranque:

```bash
cd ~/postiz-app/deploy/oracle && docker compose logs -f postiz
```

Cuando el log muestre el backend en el puerto 3000 y el frontend en el 4200,
abre `https://alpine.tail1234.ts.net` (con tu tailnet).

## 5. Usuarios

1.  Regístrate primero: la primera cuenta es la administradora.
2.  Invita al equipo desde **Settings → Team** y asigna los roles del flujo.
3.  Cuando todos estén dentro, cierra el registro: en `deploy/oracle/.env`
    pon `DISABLE_REGISTRATION=true` y corre `docker compose up -d` en esa
    carpeta.

## 6. Redes sociales y correo

Llena en `deploy/oracle/.env` las claves de Facebook, Instagram, LinkedIn y,
si quieren correos, Resend. Luego `docker compose up -d`. Las URL de
redirección que piden Meta y LinkedIn están en `docs/fork/runbook.md`
("Apps de las redes"), con `https://alpine.<tu-tailnet>.ts.net` como dominio.

## Operación

| Tarea | Comando (en `~/postiz-app/deploy/oracle`) |
|---|---|
| Ver estado | `docker compose ps` |
| Ver logs | `docker compose logs -f postiz` |
| Reiniciar la app | `docker compose restart postiz` |
| Actualizar al último commit | `bash update.sh` |
| Backup ahora | `sudo bash backup.sh` |
| Panel de Temporal | desde tu Mac: `ssh -L 8080:127.0.0.1:8080 ubuntu@<ip>` y abre `http://localhost:8080` |

### Backups

`backup.sh` guarda cada día, en `/var/backups/alpine-socials`, la base de la
app (`postiz-*.dump`) y los archivos subidos (`uploads-*.tar.gz`), y borra
los de más de 14 días. Los backups viven en la misma máquina: cópialos fuera
de vez en cuando, por ejemplo desde tu Mac:

```bash
scp -r ubuntu@<ip>:/var/backups/alpine-socials ~/alpine-socials-backups
```

La base de Temporal no se respalda: guarda solo la programación de los
posts, y la app vuelve a crear la que falte al arrancar.

### Restaurar

```bash
cd ~/postiz-app/deploy/oracle && docker compose stop postiz
```

```bash
docker exec -i postiz-postgres pg_restore -U postiz -d postiz --clean --if-exists < /var/backups/alpine-socials/postiz-<fecha>.dump
```

```bash
docker run --rm -v alpine-socials_postiz-uploads:/uploads -v /var/backups/alpine-socials:/backup alpine tar xzf /backup/uploads-<fecha>.tar.gz -C /uploads
```

```bash
docker compose start postiz
```
