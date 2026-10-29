#!/bin/bash

set -o xtrace
set -o errexit

# FORK: approvals - Dockerfile.dev has no "dist" or "devcontainer" targets, so
# the image is built whole and pushed to the fork's registry. FORK_IMAGE is the
# full image name, for example ghcr.io/<user>/postiz-app:approvals
# (see docs/fork/runbook.md for docker login).
: "${FORK_IMAGE:?set FORK_IMAGE, for example ghcr.io/<user>/postiz-app:approvals}"

docker build -t "${FORK_IMAGE}" -f Dockerfile.dev .
docker push "${FORK_IMAGE}"
