// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PumpTooltipContent — Renders pump info (status, flow, suction/discharge pressure,
 * differential head, speed, power, motor current, bearing/motor temperature,
 * vibration, NPSH margin, run hours) inside the generic TooltipLayer.
 *
 * Vibration color zones follow ISO 10816-3 class II (medium machines, rigid
 * mount): A ≤2.8 ok, 2.8–4.5 warn, 4.5–7.1 alarm, >7.1 trip. The tooltip
 * only shows rows for values that are > 0 to keep it compact for simple pumps.
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for pump tooltips. */
export interface PumpTooltipData extends TooltipData {
  type: 'pump';
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

/** ISO 10816-3 class II (medium machines on rigid mount) vibration zones, mm/s RMS. */
function getVibrationColor(vib: number): string | undefined {
  if (vib <= 0) return undefined;
  if (vib > 7.1) return '#D0021B'; // zone D — trip
  if (vib > 4.5) return '#D0021B'; // zone C upper — alarm
  if (vib > 2.8) return '#F5A623'; // zone B — warning
  return '#27AE60';                 // zone A — good
}

/** Generic "above limit" color — yellow >= 90%, red >= 100% of limit. */
function getHighLimitColor(value: number, limit: number): string | undefined {
  if (limit <= 0 || value <= 0) return undefined;
  if (value >= limit) return '#D0021B';
  if (value >= limit * 0.9) return '#F5A623';
  return undefined;
}

/** Pump tooltip content provider component. */
export function PumpTooltipContent({ data, viewer }: TooltipContentProps<PumpTooltipData>) {
  const [pumpData, setPumpData] = useState<{
    flowRate: number;
    state: string;
    suctionPressure: number;
    dischargePressure: number;
    differentialPressure: number;
    speedRpm: number;
    speedPercent: number;
    powerKw: number;
    currentA: number;
    bearingTempC: number;
    motorTempC: number;
    vibrationMmS: number;
    npshAvailable: number;
    npshRequired: number;
    npshMargin: number | null;
    runHours: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvPump;
      if (!rv) return;
      setPumpData({
        flowRate: rv.flowRate ?? 0,
        state: rv.state ?? 'ok',
        suctionPressure: rv.suctionPressure ?? 0,
        dischargePressure: rv.dischargePressure ?? 0,
        differentialPressure: rv.differentialPressure ?? 0,
        speedRpm: rv.speedRpm ?? 0,
        speedPercent: rv.speedPercent ?? 0,
        powerKw: rv.powerKw ?? 0,
        currentA: rv.currentA ?? 0,
        bearingTempC: rv.bearingTempC ?? 0,
        motorTempC: rv.motorTempC ?? 0,
        vibrationMmS: rv.vibrationMmS ?? 0,
        npshAvailable: rv.npshAvailable ?? 0,
        npshRequired: rv.npshRequired ?? 0,
        npshMargin: rv.npshMargin ?? null,
        runHours: rv.runHours ?? 0,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!pumpData) return null;

  const isRunning = pumpData.flowRate > 0;
  const isFault = pumpData.state === 'fault';
  const isWarning = pumpData.state === 'warning';

  // Header status: fault > warning > running > stopped.
  let statusColor = '#9B9B9B';
  let statusText = 'Stopped';
  if (isFault) { statusColor = '#D0021B'; statusText = 'Fault'; }
  else if (isWarning) { statusColor = '#F5A623'; statusText = 'Warning'; }
  else if (isRunning) { statusColor = '#27AE60'; statusText = 'Running'; }

  const vibColor = getVibrationColor(pumpData.vibrationMmS);
  const bearingColor = getHighLimitColor(pumpData.bearingTempC, 90);   // 90°C typical bearing trip
  const motorColor = getHighLimitColor(pumpData.motorTempC, 120);      // 120°C typical motor winding limit
  const npshColor = pumpData.npshMargin !== null && pumpData.npshMargin < 0.5
    ? '#D0021B'
    : pumpData.npshMargin !== null && pumpData.npshMargin < 1.0
      ? '#F5A623'
      : undefined;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
        <Box sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: statusColor,
          flexShrink: 0,
        }} />
        <Typography
          variant="subtitle2"
          sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
        >
          {data.nodePath.split('/').pop() ?? 'Pump'}
        </Typography>
        <Typography variant="caption" sx={{ color: statusColor, fontSize: 10, fontWeight: 600, ml: 'auto' }}>
          {statusText}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Pump
      </Typography>
      <Row label="Flow" value={formatFlow(pumpData.flowRate)} />
      {(pumpData.suctionPressure !== 0 || pumpData.dischargePressure !== 0) && (
        <>
          <Row label="Suction" value={`${pumpData.suctionPressure.toFixed(2)} bar`} />
          <Row label="Discharge" value={`${pumpData.dischargePressure.toFixed(2)} bar`} />
          <Row label="ΔP" value={`${pumpData.differentialPressure.toFixed(2)} bar`} />
        </>
      )}
      {(pumpData.speedRpm > 0 || pumpData.speedPercent > 0) && (
        <Row
          label="Speed"
          value={
            pumpData.speedPercent > 0
              ? `${pumpData.speedPercent.toFixed(0)}%${pumpData.speedRpm > 0 ? ` · ${pumpData.speedRpm.toFixed(0)} rpm` : ''}`
              : `${pumpData.speedRpm.toFixed(0)} rpm`
          }
        />
      )}
      {pumpData.powerKw > 0 && (
        <Row label="Power" value={`${pumpData.powerKw.toFixed(2)} kW`} />
      )}
      {pumpData.currentA > 0 && (
        <Row label="Current" value={`${pumpData.currentA.toFixed(1)} A`} />
      )}
      {pumpData.bearingTempC > 0 && (
        <Row label="Bearing" value={`${pumpData.bearingTempC.toFixed(1)} °C`} color={bearingColor} />
      )}
      {pumpData.motorTempC > 0 && (
        <Row label="Motor Temp" value={`${pumpData.motorTempC.toFixed(1)} °C`} color={motorColor} />
      )}
      {pumpData.vibrationMmS > 0 && (
        <Row label="Vibration" value={`${pumpData.vibrationMmS.toFixed(2)} mm/s`} color={vibColor} />
      )}
      {pumpData.npshMargin !== null && (
        <Row label="NPSH Margin" value={`${pumpData.npshMargin.toFixed(1)} m`} color={npshColor} />
      )}
      {pumpData.runHours > 0 && (
        <Row label="Run Hours" value={`${pumpData.runHours.toFixed(0)} h`} />
      )}
    </>
  );
}

// ── Self-registration (content provider only) ──
// The data resolver for 'pump' is registered by the RVPump class module via
// registerTooltipComponent() — single source of truth.
tooltipRegistry.register({
  contentType: 'pump',
  component: PumpTooltipContent as any,
});
