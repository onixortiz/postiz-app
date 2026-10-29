#!/bin/bash
# FORK: installs Alpine Socials on a fresh Oracle Cloud Ubuntu VM (ARM).
# Run it on the VM from the repo checkout:
#   sudo bash deploy/oracle/setup.sh
# It asks for the tailnet name and a Tailscale auth key the first time and
# keeps them, with generated secrets, in deploy/oracle/.env.
# See deploy/oracle/README.md.

set -o errexit
set -o nounset
set -o pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo bash deploy/oracle/setup.sh"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${DIR}/.env"
OWNER="${SUDO_USER:-ubuntu}"

# === Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "${OWNER}"
fi
systemctl enable --now docker

# === .env, only the first time
if [ ! -f "${ENV_FILE}" ]; then
  read -r -p "Tailnet DNS name (Tailscale admin > DNS, for example tail1234.ts.net): " TAILNET
  read -r -p "Tailscale auth key (tskey-auth-...): " TS_AUTHKEY
  if [ -z "${TAILNET}" ] || [ -z "${TS_AUTHKEY}" ]; then
    echo "The tailnet name and the auth key are both required."
    exit 1
  fi
  TS_HOSTNAME=alpine
  umask 077
  cat >"${ENV_FILE}" <<EOF
TS_HOSTNAME=${TS_HOSTNAME}
APP_DOMAIN=${TS_HOSTNAME}.${TAILNET}
# only used for the first login, the node keeps its state in a volume
TS_AUTHKEY=${TS_AUTHKEY}
JWT_SECRET=$(openssl rand -hex 48)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
TEMPORAL_DB_PASSWORD=$(openssl rand -hex 24)
DISABLE_REGISTRATION=false

# Social apps (see docs/fork/runbook.md, "Apps de las redes")
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=

# Email (Resend). Empty: in-app notices only
RESEND_API_KEY=
EMAIL_FROM_ADDRESS=
EMAIL_FROM_NAME=Alpine Socials
EOF
  chown "${OWNER}" "${ENV_FILE}"
  echo "Wrote ${ENV_FILE}"
fi

# === Daily backup at 03:30 (server time)
cat >/etc/cron.d/alpine-socials-backup <<EOF
30 3 * * * root bash ${DIR}/backup.sh >>/var/log/alpine-socials-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/alpine-socials-backup

# === Build and start. The first build takes 15 to 25 minutes.
cd "${DIR}"
docker compose up -d --build

echo
echo "Started. Follow the start with: cd ${DIR} && docker compose logs -f postiz"
