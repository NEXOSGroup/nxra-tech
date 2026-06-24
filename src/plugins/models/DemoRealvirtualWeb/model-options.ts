// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * model-options.ts — Selectable model options for the DemoRealvirtualWeb base model.
 *
 * Selector metadata only (id + label). What each option *does* is spelled out
 * imperatively in index.ts (`applyModelOption`) using the command helpers from
 * ../model-option-plugin.ts. main.ts eager-globs every `models/<name>/model-options.ts`
 * to build the selector, so this stays dependency-light (a type-only import is erased).
 */

import type { ModelOptionDef } from '../model-option-plugin';

/** Base GLB (filename without .glb) these options apply to. */
export const baseModel = 'DemoRealvirtualWeb';

/** Selectable supplier variants. Behaviour lives in index.ts `applyModelOption`. */
export const modelOptions: ModelOptionDef[] = [
  { id: 'bosch', label: 'Bosch' },
  { id: 'sew', label: 'SEW' },
];
