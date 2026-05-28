// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Hierarchy badge presentational components.
 *
 * Stateless components extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5):
 * - `BadgeChip` — small colored MUI Chip used for type / signal labels
 * - `StepStateDot` — pulsing dot indicating Active / Waiting LogicStep state
 * - `ContainerProgressBadge` — small monospace progress counter (e.g. "1.2s/3.0s")
 * - `NodeBadges` — composite row that renders type badges + live signal badges
 */

import { memo, useMemo } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import type { SignalStore } from '../engine/rv-signal-store';
import type { StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { STEP_STATE_COLORS } from './rv-logic-step-colors';
import {
  badgeColor,
  badgeLabel,
  formatContainerProgress,
  formatSignalValue,
  isLogicStepType,
  signalBadgeColor,
  splitTypes,
} from './hierarchy-utils';

// ─── BadgeChip ───────────────────────────────────────────────────────────

export function BadgeChip({ color, label }: { color: string; label: string }) {
  return (
    <Chip
      label={label}
      size="small"
      sx={{
        height: 14,
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: 0.3,
        bgcolor: color + '22',
        color: color,
        border: `1px solid ${color}44`,
        flexShrink: 0,
        maxWidth: 100,
        '& .MuiChip-label': { px: 0.4, py: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      }}
    />
  );
}

// ─── StepStateDot ────────────────────────────────────────────────────────

export function StepStateDot({ stepState }: { stepState: StepState }) {
  // Only show dot for Active (pulsing green) and Waiting (pulsing amber). No dot for Idle/Finished.
  if (stepState === StepState.Idle || stepState === StepState.Finished) return null;
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: STEP_STATE_COLORS[stepState],
        flexShrink: 0,
        mr: 0.5,
        animation: 'rv-pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ─── ContainerProgressBadge ──────────────────────────────────────────────

export function ContainerProgressBadge({ text }: { text: string }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 8,
        fontFamily: 'monospace',
        color: 'text.secondary',
        ml: 0.25,
        flexShrink: 0,
      }}
    >
      {text}
    </Typography>
  );
}

// ─── NodeBadges (composite) ──────────────────────────────────────────────

export interface NodeBadgesProps {
  types: string[];
  signalStore: SignalStore | null;
  path: string | null;
  stepInfo?: StepStateInfo | null;
}

/** Renders component badges + signal badges (signals always right-most with live values). */
export const NodeBadges = memo(function NodeBadges({
  types,
  signalStore,
  path,
  stepInfo,
}: NodeBadgesProps) {
  const [nonSignalTypes, signalTypes] = useMemo(() => splitTypes(types), [types]);

  if (nonSignalTypes.length === 0 && signalTypes.length === 0) return null;

  const stepState = stepInfo?.state;
  const progressText = stepInfo ? formatContainerProgress(stepInfo) : null;

  return (
    <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 1, ml: 'auto', alignItems: 'center', overflow: 'hidden', minWidth: 0 }}>
      {nonSignalTypes.map((type) => (
        <BadgeChip
          key={type}
          color={badgeColor(type, isLogicStepType(type) ? stepState : undefined)}
          label={badgeLabel(type, isLogicStepType(type) ? stepState : undefined)}
        />
      ))}
      {progressText && <ContainerProgressBadge text={progressText} />}
      {signalTypes.length > 0 && nonSignalTypes.length > 0 && (
        <Box sx={{ width: 2, flexShrink: 0 }} />
      )}
      {signalTypes.map((type) => (
        <BadgeChip
          key={type}
          color={signalBadgeColor(type, signalStore, path)}
          label={`${badgeLabel(type)} ${formatSignalValue(type, signalStore, path)}`}
        />
      ))}
    </Box>
  );
});
