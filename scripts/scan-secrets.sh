#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --silent --show-error --retry 3 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$temporary/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$temporary/gitleaks.tar.gz" | sha256sum --check
tar -xzf "$temporary/gitleaks.tar.gz" -C "$temporary" gitleaks
"$temporary/gitleaks" git . --redact --no-banner --log-opts="--all"
