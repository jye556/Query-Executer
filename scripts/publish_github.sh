#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this script from a Git checkout." >&2
  exit 1
}
cd "$ROOT"

REMOTE_URL="$(git remote get-url origin)"
EXPECTED_REMOTE="https://github.com/jye556/Query-Executer.git"
if [[ "$REMOTE_URL" != "$EXPECTED_REMOTE" ]]; then
  echo "Unexpected origin: $REMOTE_URL" >&2
  echo "Expected: $EXPECTED_REMOTE" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit intended changes before publishing." >&2
  git status --short
  exit 1
fi

while IFS= read -r -d '' path; do
  case "$path" in
    .env|.env.*|!.env.example|*.db|*.dump|*.sql.gz|*.tar.gz|*.pem|*.key|backups/*|*/backups/*)
      if [[ "$path" != ".env.example" ]]; then
        echo "Refusing to publish sensitive/local file: $path" >&2
        exit 1
      fi
      ;;
  esac
done < <(git ls-files -z)

PYTHON="python3"
if [[ -x .venv/bin/python ]]; then PYTHON=".venv/bin/python"; fi
"$PYTHON" -m unittest discover -s tests -v
node --check app/static/js/app.js
bash -n install_linux.sh
POSTGRES_PASSWORD=validation-only \
BOOTSTRAP_ADMIN_PASSWORD=validation-only \
APP_ENCRYPTION_KEY=validation-only \
docker compose config --quiet

git fetch origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "Local HEAD does not contain origin/main. Integrate remote main before publishing." >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  echo "Checks passed. Would publish $(git rev-parse --short HEAD) to origin/main."
  exit 0
fi
if [[ $# -gt 0 && "$1" != "--release" ]]; then
  echo "Usage: $0 [--check|--release]" >&2
  exit 2
fi

git push origin HEAD:main
REMOTE_SHA="$(git ls-remote origin refs/heads/main | cut -f1)"
LOCAL_SHA="$(git rev-parse HEAD)"
if [[ "$REMOTE_SHA" != "$LOCAL_SHA" ]]; then
  echo "Push returned, but origin/main does not match local HEAD." >&2
  exit 1
fi
echo "Verified: origin/main now points to $LOCAL_SHA."

if [[ "${1:-}" == "--release" ]]; then
  command -v gh >/dev/null || { echo "Install/authenticate gh before creating the release." >&2; exit 1; }
  VERSION="$("$PYTHON" -c 'import json; print(json.load(open("app/releases.json"))["version"])')"
  TAG="v$VERSION"
  gh release create "$TAG" --target main --title "$TAG" --generate-notes
  gh release view "$TAG" --json tagName,url --jq '"Verified release " + .tagName + ": " + .url'
else
  VERSION="$("$PYTHON" -c 'import json; print(json.load(open("app/releases.json"))["version"])')"
  echo "Code published. To publish the GitHub release too, rerun with: $0 --release"
  echo "Release version: v$VERSION"
fi
