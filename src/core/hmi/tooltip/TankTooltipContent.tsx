// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TankTooltipContent — Renders tank info (fill level, capacity, temperature, pressure,
 * density, pH, mass, mixer/heater status) inside the generic TooltipLayer.
 *
 * Includes a mini fill-level bar with ISA-101-compliant color coding and
 * uses the same red/yellow/green convention for temperature/pressure when
 * alarm thresholds are authored on the component.
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for tank tooltips. */
export interface TankTooltipData extends TooltipData {
  type: 'tank';
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

/** ISA-101 fill-level color: green=normal, yellow=warning, red=alarm (HH/LL). */
function getLevelColor(fraction: number): string {
  if (fraction < 0.1 || fraction > 0.95) return '#D0021B'; // alarm red
  if (fraction < 0.2 || fraction > 0.9) return '#F5A623';  // warning yellow
  return '#27AE60'; // normal green
}

/** Returns alarm color vs. thresholds. `low`/`high` of 0 means "no limit authored".
 *  Uses a 10% warning band around the limit (typical ISA-101 practice). */
function getLimitColor(value: number, low: number, high: number): string | undefined {
  if (high > 0 && value >= high) return '#D0021B';
  if (high > 0 && value >= high * 0.9) return '#F5A623';
  if (low > 0 && value <= low) return '#D0021B';
  if (low > 0 && value <= low * 1.1) return '#F5A623';
  return undefined; // normal → use default white
}

/** Mini fill-level bar component. */
function FillBar({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const color = getLevelColor(clamped);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Box sx={{
        width: 60,
        height: 8,
        bgcolor: 'rgba(255,255,255,0.1)',
        borderRadius: 0.5,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <Box sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${clamped * 100}%`,
          height: '100%',
          bgcolor: color,
          transition: 'width 0.3s, background-color 0.3s',
        }} />
      </Box>
      <Typography variant="caption" sx={{ color, fontSize: 11, fontFamily: 'monospace', fontWeight: 700 }}>
        {(clamped * 100).toFixed(2)}%
      </Typography>
    </Box>
  );
}

/** Small on/off status chip (for Mixer, Heater). */
function StatusChip({ label, on }: { label: string; on: boolean }) {
  return (
    <Box sx={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.5,
      bgcolor: on ? 'rgba(39,174,96,0.2)' : 'rgba(255,255,255,0.06)',
      border: `1px solid ${on ? '#27AE60' : 'rgba(255,255,255,0.15)'}`,
      borderRadius: 0.75,
      px: 0.75,
      py: 0.125,
    }}>
      <Box sx={{
        width: 6, height: 6, borderRadius: '50%',
        bgcolor: on ? '#27AE60' : 'rgba(255,255,255,0.3)',
      }} />
      <Typography variant="caption" sx={{
        color: on ? '#27AE60' : 'rgba(255,255,255,0.5)',
        fontSize: 10, fontWeight: 600,
      }}>
        {label}
      </Typography>
    </Box>
  );
}

/** Tank tooltip content provider component. */
export function TankTooltipContent({ data, viewer }: TooltipContentProps<TankTooltipData>) {
  const [tankData, setTankData] = useState<{
    resourceName: string;
    capacity: number;
    amount: number;
    pressure: number;
    temperature: number;
    density: number;
    ph: number;
    agitatorOn: boolean;
    heatingOn: boolean;
    tempHighLimit: number;
    tempLowLimit: number;
    pressureHighLimit: number;
    massKg: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvTank;
      if (!rv) return;
      setTankData({
        resourceName: rv.resourceName || 'Unknown',
        capacity: rv.capacity ?? 0,
        amount: rv.amount ?? 0,
        pressure: rv.pressure ?? 0,
        temperature: rv.temperature ?? 0,
        density: rv.density ?? 0,
        ph: rv.ph ?? 0,
        agitatorOn: !!rv.agitatorOn,
        heatingOn: !!rv.heatingOn,
        tempHighLimit: rv.tempHighLimit ?? 0,
        tempLowLimit: rv.tempLowLimit ?? 0,
        pressureHighLimit: rv.pressureHighLimit ?? 0,
        massKg: rv.massKg ?? 0,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!tankData) return null;

  const fraction = tankData.capacity > 0 ? tankData.amount / tankData.capacity : 0;
  const tempColor = getLimitColor(tankData.temperature, tankData.tempLowLimit, tankData.tempHighLimit);
  const pressureColor = getLimitColor(tankData.pressure, 0, tankData.pressureHighLimit);
  const hasMixerOrHeater = tankData.agitatorOn || tankData.heatingOn;

  return (
    <>
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {data.nodePath.split('/').pop() ?? 'Tank'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Tank
      </Typography>
      <FillBar fraction={fraction} />
      <Row label="Level" value={`${tankData.amount.toFixed(0)} / ${tankData.capacity.toFixed(0)} l`} />
      <Row label="Medium" value={tankData.resourceName} />
      {tankData.density > 0 && (
        <Row label="Density" value={`${tankData.density.toFixed(0)} kg/m³`} />
      )}
      {tankData.massKg > 0 && (
        <Row label="Mass" value={`${tankData.massKg.toFixed(0)} kg`} />
      )}
      {tankData.temperature !== 0 && (
        <Row label="Temp" value={`${tankData.temperature.toFixed(1)} °C`} color={tempColor} />
      )}
      {tankData.pressure !== 0 && (
        <Row label="Pressure" value={`${tankData.pressure.toFixed(2)} bar`} color={pressureColor} />
      )}
      {tankData.ph > 0 && (
        <Row label="pH" value={tankData.ph.toFixed(2)} />
      )}
      {hasMixerOrHeater && (
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
          {tankData.agitatorOn && <StatusChip label="Mixer" on={true} />}
          {tankData.heatingOn && <StatusChip label="Heater" on={true} />}
        </Box>
      )}
    </>
  );
}

// ── Self-registration (content provider only) ──
// The data resolver for 'tank' is registered by the RVTank class module via
// registerTooltipComponent() — single source of truth.
tooltipRegistry.register({
  contentType: 'tank',
  component: TankTooltipContent as any,
});
