// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PipeTooltipContent — Renders pipe info (medium, flow + direction, line
 * pressure, temperature, fluid velocity, nominal diameter) inside the generic
 * TooltipLayer.
 *
 * Velocity > 3 m/s is flagged yellow (typical API RP 14E erosion warning for
 * liquids); > 6 m/s is flagged red. Self-registers in the TooltipContentRegistry
 * at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for pipe tooltips. */
export interface PipeTooltipData extends TooltipData {
  type: 'pipe';
  nodePath: string;
}

/** Row helper: label on left, value on right in monospace (optionally colored). */
function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: color ?? '#fff', fontSize: 11, fontFamily: 'monospace' }}>
        {value}
      </Typography>
    </Box>
  );
}

function formatFlow(val: number): string {
  if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(2)} m³/h`;
  return `${val.toFixed(1)} l/min`;
}

/** Liquid erosion velocity zones (rule-of-thumb used widely in process piping). */
function getVelocityColor(v: number): string | undefined {
  if (v <= 0) return undefined;
  if (v > 6) return '#D0021B';   // erosion/flashing risk
  if (v > 3) return '#F5A623';   // approaching upper limit
  return undefined;
}

/** Pipe tooltip content provider component. */
export function PipeTooltipContent({ data, viewer }: TooltipContentProps<PipeTooltipData>) {
  const [pipeData, setPipeData] = useState<{
    resourceName: string;
    flowRate: number;
    pressure: number;
    temperatureC: number;
    velocityMs: number;
    dnSize: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvPipe;
      if (!rv) return;
      setPipeData({
        resourceName: rv.resourceName || 'Unknown',
        flowRate: rv.flowRate ?? 0,
        pressure: rv.pressure ?? 0,
        temperatureC: rv.temperatureC ?? 0,
        velocityMs: rv.velocityMs ?? 0,
        dnSize: rv.dnSize ?? 0,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!pipeData) return null;

  const dirArrow = pipeData.flowRate > 0 ? ' →' : pipeData.flowRate < 0 ? ' ←' : '';
  const velocityColor = getVelocityColor(pipeData.velocityMs);

  return (
    <>
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {data.nodePath.split('/').pop() ?? 'Pipe'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        {pipeData.dnSize > 0 ? `Pipe · DN${pipeData.dnSize}` : 'Pipe'}
      </Typography>
      <Row label="Medium" value={pipeData.resourceName} />
      <Row label="Flow" value={`${formatFlow(pipeData.flowRate)}${dirArrow}`} />
      {pipeData.velocityMs > 0 && (
        <Row label="Velocity" value={`${pipeData.velocityMs.toFixed(2)} m/s`} color={velocityColor} />
      )}
      {pipeData.pressure !== 0 && (
        <Row label="Pressure" value={`${pipeData.pressure.toFixed(2)} bar`} />
      )}
      {pipeData.temperatureC !== 0 && (
        <Row label="Temp" value={`${pipeData.temperatureC.toFixed(1)} °C`} />
      )}
    </>
  );
}

// ── Self-registration (content provider only) ──
// The data resolver for 'pipe' is registered by the RVPipe class module via
// registerTooltipComponent() — single source of truth.
tooltipRegistry.register({
  contentType: 'pipe',
  component: PipeTooltipContent as any,
});
