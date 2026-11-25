#!/usr/bin/env bash
set -euo pipefail

echo "=== Owly RAG (owly-rag) — Local Setup ==="

if command -v uv >/dev/null 2>&1; then
  echo "Using uv for Python environment..."
  uv sync
else
  echo "uv not found; falling back to python3 venv + pip..."
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --upgrade pip
  pip install -r backend/requirements.txt
fi

cp -n .env.example .env || true

echo "Installing frontend dependencies..."
if command -v bun >/dev/null 2>&1; then
  (cd frontend && bun install)
elif command -v pnpm >/dev/null 2>&1; then
  (cd frontend && pnpm install)
elif command -v yarn >/dev/null 2>&1; then
  (cd frontend && yarn install)
else
  (cd frontend && npm install)
fi

echo ""
echo "Setup complete. To run locally:"
echo "  1. Ensure Ollama is running: ollama serve"
echo "  2. Start backend:  uv run uvicorn backend.app.main:app --reload --port 8000"
echo "  3. Start frontend: cd frontend && bun run dev (http://localhost:3000)"
