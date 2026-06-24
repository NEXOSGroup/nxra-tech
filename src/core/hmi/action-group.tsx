// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared "action group" design — a compact glassy pill of full-height,
 * rectangular ButtonBase segments split by dividers. Used by the floating
 * top-left (mode + sim controls) and top-right (camera / view controls)
 * clusters so every action group looks identical (same height, spacing, hover).
 */

import type { ReactNode } from 'react';
import { Box, Paper, ButtonBase, Divider, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Shared sizing for every action group — a single source of truth so all pills
 * line up with each other and with the ModeDropdown (same 22px desktop height).
 */
/** Fixed pill height. A *fixed* (not min-) height lets each segment's
 *  `height:'100%'` resolve deterministically → reliable vertical centering. */
const PILL_HEIGHT = { xs: 32, sm: 22 };
/** Every segment icon is forced to this size, so no group can look different. */
const SEGMENT_ICON_PX = 18;

/** Glassy pill wrapper. Segments fill it edge-to-edge; corners clip via overflow. */
export function ActionGroupPill({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Paper
      data-ui-panel
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 1,
        overflow: 'hidden',
        height: PILL_HEIGHT,
        ...(sx as Record<string, unknown>),
      }}
    >
      {children}
    </Paper>
  );
}

/** Thin vertical divider between segments. */
export function ActionDivider() {
  return <Divider orientation="vertical" flexItem sx={{ borderColor: 'rgba(255,255,255,0.12)' }} />;
}

interface ActionSegmentProps {
  title: string;
  onClick?: () => void;
  /** Active state → subtle primary highlight + primary text (unless `color` set). */
  active?: boolean;
  /** Explicit text/icon color override (e.g. 'warning.main', a hex string). */
  color?: string;
  /** The icon element (any MUI icon). Auto-normalized to {@link SEGMENT_ICON_PX}. */
  icon?: ReactNode;
  /** Optional text label (e.g. "VR", a camera number) in the shared label style. */
  label?: ReactNode;
  /** Extra props forwarded to the ButtonBase (pointer handlers, data-testid, …). */
  buttonProps?: Record<string, unknown>;
  sx?: SxProps<Theme>;
}

/**
 * One full-height segment with a fixed, normalized layout: an optional icon (forced
 * to a single size, `display:block` to kill the inline-SVG baseline gap) followed by
 * an optional label (shared typography). This guarantees every segment — across every
 * action group — has identical height, icon size, and vertical centering.
 */
export function ActionSegment({ title, onClick, active, color, icon, label, buttonProps, sx }: ActionSegmentProps) {
  return (
    <Tooltip title={title} placement="bottom">
      <ButtonBase
        onClick={onClick}
        {...buttonProps}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: icon && label != null ? 0.5 : 0,
          px: 0.75,
          height: '100%',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          color: color ?? (active ? 'primary.main' : 'inherit'),
          bgcolor: active ? 'rgba(79,195,247,0.15)' : 'transparent',
          transition: 'background-color 120ms',
          // Normalize every icon to one size + remove the inline baseline offset.
          '& svg': { fontSize: `${SEGMENT_ICON_PX}px`, display: 'block' },
          '&:hover': { bgcolor: active ? 'rgba(79,195,247,0.22)' : 'rgba(255,255,255,0.1)' },
          ...(sx as Record<string, unknown>),
        }}
      >
        {icon}
        {label != null && (
          <Box component="span" sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>{label}</Box>
        )}
      </ButtonBase>
    </Tooltip>
  );
}
