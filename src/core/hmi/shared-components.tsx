// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * shared-components.tsx — Tiny React presentational components used in 2+ HMI
 * panels. Extracted to remove copy-paste duplication of "obvious" wrappers.
 *
 * Keep this file focused — only add components that are pure presentational
 * and have no panel-specific state. Anything panel-specific (sticky badges,
 * tab-state, etc.) belongs next to its consumer.
 */

import React from 'react';
import { Typography } from '@mui/material';

/**
 * Section header — small uppercase caption used to introduce a logical group
 * of settings/stats inside a panel. Replaces the identical local definitions
 * in `settings/DevToolsTab.tsx` and `scene/SceneWindow.tsx`.
 *
 * Styles match the canonical caption recipe (10px, weight 600, 1px letter-
 * spacing, uppercase, `text.secondary` color). Callers that need a different
 * tone/weight should keep their own local definition rather than parameterize
 * this one — see `MachineControlPanel.tsx` for an example of a deliberately
 * different style.
 */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{
        color: 'text.secondary',
        textTransform: 'uppercase',
        letterSpacing: 1,
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {children}
    </Typography>
  );
}
