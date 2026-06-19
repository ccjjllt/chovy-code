# Known Limitations

- `CHOVY_E2E_USE_MOCK=1` is for local smoke/demo only; it does not validate provider-specific HTTP behavior.
- WebFetch converts static HTML to markdown; it does not execute JavaScript or drive a browser.
- Bash sandboxing is weaker on Windows because there is no bwrap-style isolation.
- Vision input is provider-dependent and is not normalized across every adapter yet.
- Multi-file edits are not atomic; file writes are atomic per file.
- TEAMMEM/team-shared memory is intentionally not implemented.
- Anthropic prompt-cache behavior is treated as diagnostics only; chovy-code does not implement Anthropic-only price optimization logic.
- Memory injection is deterministic FTS/importance ranking, not semantic embeddings; highly paraphrased memories may be missed.
- Context rebuild archives full message history to local JSONL, but there is no first-class CLI to search session archives yet.
- Skill auto-planning is opt-in via `CHOVY_SKILLS_AUTO=1` or `feature('skills.auto')`; manual skill activation works by default.
- Bench thresholds are reference numbers, not hard CI gates; slow disks or Windows process startup may print `WARN`.
