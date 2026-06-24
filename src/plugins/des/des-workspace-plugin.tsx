// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DESWorkspacePlugin — thin workspace shell for the DES mode (plan-198).
 *
 * DES (Discrete Event Simulation) is registered as a first-class workspace
 * mode. The actual DES execution kernel/runner is a PRIVATE component
 * (`createDesRunner` is null in public builds), and the Realtime/DES execution
 * toggle (`SimModeToggle`) is ORTHOGONAL — it already lives in the always-on
 * `toolbar-button-leading` slot. This plugin provides only the DES-specific UI
 * surface: a small info panel that appears when DES mode is active, reporting
 * whether the DES runner is available in this build.
 *
 * `modes: ['des']` makes both the plugin and its UI auto-gate to DES mode (the
 * UI registry compiles `modes` into a `mode:des` visibility rule on the slot).
 */

import { Box, Paper, Typography } from '@mui/material';
import { AccountTree } from '@mui/icons-material';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import { useViewer } from '../../hooks/use-viewer';

/** Info card shown while in DES mode. Honest about runner availability. */
function DESWorkspacePanel({ viewer }: UISlotProps) {
  const hasRunner = viewer.simulationKernel?.hasDesRunner() ?? false;
  return (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        px: 2,
        py: 1.25,
        borderRadius: 2,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        maxWidth: 420,
      }}
    >
      <AccountTree fontSize="small" />
      <Box>
        <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>
          Discrete Event Simulation
        </Typography>
        <Typography sx={{ fontSize: 12, opacity: 0.75, lineHeight: 1.3 }}>
          {hasRunner
            ? 'DES runner ready — use the Realtime / DES toggle to switch the execution kernel.'
            : 'DES runner not available in this build.'}
        </Typography>
      </Box>
    </Paper>
  );
}

export class DESWorkspacePlugin implements RVViewerPlugin {
  readonly id = 'des-workspace';
  readonly order = 260;

  /** plan-198: this plugin (and its UI) is active only in DES workspace mode. */
  readonly modes: ModeId[] = ['des'];

  readonly slots: UISlotEntry[] = [
    { slot: 'overlay', component: DESWorkspacePanel, order: 100 },
  ];
}
