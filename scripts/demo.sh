#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT}"

echo "== chovy-code demo: five innovations =="

echo
echo "1) ATP: adaptive lean/full tool descriptions"
bun run bench:tool-budget

echo
echo "2) SwarmR: dispatch 100 mocked sub-agents"
bun run bench:swarm-100

echo
echo "3) TMT + mock E2E: isolated memory write/search + provider chat"
bun run smoke | grep -E "mem write|mem search|mock provider chat|passed"

echo
echo "4) SCW: context rebuild benchmark"
bun run bench:context-rebuild

echo
echo "5) CSG: skill graph is available and inspectable"
CHOVY_SKILLS_AUTO=1 bun src/cli/index.tsx skill list | grep -E "commit|review|ts-fix"

echo
echo "Bonus: /goal headless entry"
bun src/cli/index.tsx goal --help | grep -E "max-rounds|budget-usd"

echo
echo "Demo complete."
