// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ChainTransfer — naming-convention demo.
 *
 * The GLB is expected to carry a `WebLibraryComponent` marker on its root,
 * so the naming-convention loader (Drive-Lin-X, Transport-Z, etc.) already wires
 * the kinematics. This behavior file exists to:
 *
 *   1. Demonstrate the minimum possible behavior file (just `models[]`).
 *   2. Provide a place to add behavior code later (signals, FixedUpdate)
 *      without touching the GLB.
 */

import { defineBehavior } from '../core/behaviors';

export default defineBehavior({
  models: ['ChainTransfer', 'ChainTransfer_*'],
  bind(/* rv */) {
    // No-op: the WebLibraryComponent marker on the GLB drives all wiring.
  },
});
