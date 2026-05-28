// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Minimal type shim for the `n8ao` package — the upstream package ships
 * runtime-only with no `.d.ts`. We only consume `N8AOPass` via dynamic
 * import in rv-viewer.ts, and the import is then re-typed with `as` to
 * the pass interface. This shim exists solely to silence TS7016.
 */
declare module 'n8ao' {
  // Re-export anything as unknown — the actual usage in rv-viewer.ts casts
  // through `Record<string, unknown>` and a hand-written constructor type,
  // so a precise definition here would just duplicate that.
  export const N8AOPass: unknown;
  const _default: unknown;
  export default _default;
}
