#!/bin/bash
# Double-click launcher for macOS. Runs the sync and opens the output folder.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (version 26 or newer), then run this again."
  read -r -p "Press Enter to close."; exit 2
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm (one time)..."; npm install -g pnpm@10 >/dev/null 2>&1 || { echo "Could not install pnpm."; read -r -p "Press Enter to close."; exit 2; }
fi
[ -d node_modules ] || pnpm install
pnpm sync
status=$?
if [ $status -eq 0 ]; then open "data/out/latest" 2>/dev/null; else echo; echo "The sync failed with exit code $status (see README for what it means)."; fi
echo; read -r -p "Press Enter to close."
