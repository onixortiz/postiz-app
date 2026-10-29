#!/bin/bash
# FORK: brings the VM to the latest commit of the current branch and rebuilds.
#   bash deploy/oracle/update.sh

set -o errexit
set -o nounset
set -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

git -C "${DIR}/../.." pull --ff-only
cd "${DIR}"
docker compose up -d --build
docker image prune -f
