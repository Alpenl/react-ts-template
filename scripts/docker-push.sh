#!/usr/bin/env bash

set -euo pipefail

# Change to project root directory (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

print_usage() {
  cat <<'EOF'
Usage:
  scripts/docker-push.sh [tag] [build_mode] [output_dir]

Defaults (can also be provided via env):
  REGISTRY    (default: crpi-oqoyx41yg9d9htn3.cn-hangzhou.personal.cr.aliyuncs.com)
  NAMESPACE   (default: alpen)
  IMAGE_NAME  (default: momaxtools)
  TAG         (default: auto-increment patch from VERSION_FILE)
  BUILD_MODE  (default: pro)
  OUTPUT_DIR  (default: dist-pro)
  VERSION_FILE (default: .docker-version)

Examples:
  ./scripts/docker-push.sh
  ./scripts/docker-push.sh v1.0.0 pro dist-pro
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_usage
  exit 0
fi

REGISTRY="${REGISTRY:-crpi-oqoyx41yg9d9htn3.cn-hangzhou.personal.cr.aliyuncs.com}"
NAMESPACE="${NAMESPACE:-alpen}"
IMAGE_NAME="${IMAGE_NAME:-momaxtools}"
TAG="${1:-${TAG:-}}"
BUILD_MODE="${2:-${BUILD_MODE:-pro}}"
OUTPUT_DIR="${3:-${OUTPUT_DIR:-dist-pro}}"
VERSION_FILE="${VERSION_FILE:-.docker-version}"

normalize_version() {
  echo "${1#v}"
}

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

next_patch_version() {
  local version="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<<"$version"
  patch=$((patch + 1))
  echo "${major}.${minor}.${patch}"
}

if [[ -z "${TAG}" ]]; then
  base_version=""
  if [[ -f "${VERSION_FILE}" ]]; then
    base_version="$(normalize_version "$(cat "${VERSION_FILE}")")"
  elif command -v node >/dev/null 2>&1 && [[ -f package.json ]]; then
    base_version="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  fi
  base_version="$(normalize_version "${base_version:-0.1.0}")"
  if ! is_semver "${base_version}"; then
    echo "Invalid base version: ${base_version}"
    exit 1
  fi
  TAG="$(next_patch_version "${base_version}")"
  printf '%s\n' "${TAG}" > "${VERSION_FILE}"
else
  normalized_tag="$(normalize_version "${TAG}")"
  if is_semver "${normalized_tag}"; then
    printf '%s\n' "${normalized_tag}" > "${VERSION_FILE}"
    TAG="${normalized_tag}"
  fi
fi

IMAGE="${REGISTRY}/${NAMESPACE}/${IMAGE_NAME}:${TAG}"
LATEST_IMAGE="${REGISTRY}/${NAMESPACE}/${IMAGE_NAME}:latest"

echo "Building ${IMAGE}"
docker build \
  --build-arg BUILD_MODE="${BUILD_MODE}" \
  --build-arg OUTPUT_DIR="${OUTPUT_DIR}" \
  -t "${IMAGE}" \
  .

echo "Tagging ${LATEST_IMAGE}"
docker tag "${IMAGE}" "${LATEST_IMAGE}"

echo "Pushing ${IMAGE}"
docker push "${IMAGE}"

echo "Pushing ${LATEST_IMAGE}"
docker push "${LATEST_IMAGE}"
