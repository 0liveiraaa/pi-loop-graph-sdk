# Phase 0 characterization baseline

Baseline recorded on 2026-07-21 at commit `6e14125`:

- `npm test`: 15 test files, 298 tests passed.
- Completion submission and output-contract behavior:
  `tests/adapter/output-contract.test.ts`,
  `tests/adapter/pi-node-context.test.ts`, and
  `tests/adapter/loop-graph-extension.test.ts`.
- Isolated Host/session behavior:
  `tests/adapter/graph-execution-host.test.ts`,
  `tests/adapter/graph-execution-host.spike.test.ts`, and
  `tests/adapter/isolated-graph-session.test.ts`.
- `call` / `compose` / `delegate` behavior:
  `tests/adapter/loop-graph-extension.test.ts` and
  `tests/adapter/isolated-graph-session.test.ts`.
- Compaction behavior:
  `tests/adapter/compaction-frame.test.ts` and
  `tests/adapter/loop-graph-extension.test.ts`.
- Published-package loading behavior:
  `tests/package-consumer/run.mjs`.

These are 0.1 characterization gates. They preserve behavior that later phases
must migrate deliberately; they do not make the 0.1 public types part of the
0.2 design.
