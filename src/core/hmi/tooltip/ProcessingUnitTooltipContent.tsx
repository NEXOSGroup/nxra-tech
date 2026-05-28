// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProcessingUnitTooltipContent — Renders processing unit info with OEE
 * (Overall Equipment Effectiveness) telemetry inside the generic TooltipLayer.
 *
 * OEE = Availability × Performance × Quality. Industry benchmark thresholds
 * used for color coding: ≥85% world-class green, 60–85% yellow, <60% red.
 *
 * The data resolver is registered by the RVProcessingUnit class module via
 * registerTooltipComponent() — this file only provides the React UI.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for processing unit tooltips. */
export interface ProcessingUnitTooltipData extends TooltipData {
  type: 'processing-unit';
  nodePath: string;
}

/** Row helper: label on left, value on right (optionally colored). */
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

/** OEE benchmark color: ≥85% world-class, 60–85% warning, <60% poor. */
function getOeeColor(percent: number): string {
  if (percent >= 85) return '#27AE60';
  if (percent >= 60) return '#F5A623';
  return '#D0021B';
}

/** State → (color, label) for the status dot and header. */
function stateMeta(state: string): { color: string; label: string } {
  switch (state) {
    case 'running':     return { color: '#27AE60', label: 'Running' };
    case 'setup':       return { color: '#4FC3F7', label: 'Setup' };
    case 'maintenance': return { color: '#F5A623', label: 'Maint.' };
    case 'down':        return { color: '#D0021B', label: 'Down' };
    case 'idle':
    default:            return { color: '#9B9B9B', label: 'Idle' };
  }
}

/** Stacked three-segment OEE bar (Availability · Performance · Quality).
 *  Segment width is proportional to segment value so the visual dominance
 *  matches which factor is dragging OEE down. */
function OeeBar({
  availability, performance, quality,
}: { availability: number; performance: number; quality: number }) {
  const a = Math.max(0, Math.min(1, availability));
  const p = Math.max(0, Math.min(1, performance));
  const q = Math.max(0, Math.min(1, quality));
  return (
    <Box sx={{
      width: '100%', height: 6, borderRadius: 0.5,
      bgcolor: 'rgba(255,255,255,0.1)', display: 'flex', overflow: 'hidden', mb: 0.75,
    }}>
      <Box sx={{ width: `${a * 100 / 3}%`, bgcolor: '#42a5f5' }} />
      <Box sx={{ width: `${p * 100 / 3}%`, bgcolor: '#ab47bc' }} />
      <Box sx={{ width: `${q * 100 / 3}%`, bgcolor: '#26c6da' }} />
    </Box>
  );
}

/** Processing unit tooltip content provider component. */
export function ProcessingUnitTooltipContent({ data, viewer }: TooltipContentProps<ProcessingUnitTooltipData>) {
  const [puData, setPuData] = useState<{
    state: string;
    availability: number;
    performance: number;
    quality: number;
    oeePercent: number;
    cycleTimeS: number;
    cycleTargetS: number;
    throughputPerHour: number;
    goodCount: number;
    scrapCount: number;
    totalCount: number;
    mtbfHours: number;
    mttrMinutes: number;
    runHours: number;
    downHours: number;
    lastFault: string;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvProcessingUnit;
      if (!rv) return;
      setPuData({
        state: rv.state ?? 'idle',
        availability: rv.availability ?? 0,
        performance: rv.performance ?? 0,
        quality: rv.quality ?? 0,
        oeePercent: rv.oeePercent ?? 0,
        cycleTimeS: rv.cycleTimeS ?? 0,
        cycleTargetS: rv.cycleTargetS ?? 0,
        throughputPerHour: rv.throughputPerHour ?? 0,
        goodCount: rv.goodCount ?? 0,
        scrapCount: rv.scrapCount ?? 0,
        totalCount: rv.totalCount ?? 0,
        mtbfHours: rv.mtbfHours ?? 0,
        mttrMinutes: rv.mttrMinutes ?? 0,
        runHours: rv.runHours ?? 0,
        downHours: rv.downHours ?? 0,
        lastFault: rv.lastFault ?? '',
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!puData) return null;

  const hasOee = puData.availability + puData.performance + puData.quality > 0;
  const oeeColor = getOeeColor(puData.oeePercent);
  const { color: stateColor, label: stateLabel } = stateMeta(puData.state);
  const qualityYield = puData.totalCount > 0 ? (puData.goodCount / puData.totalCount) * 100 : 0;
  const cycleDeviation = puData.cycleTargetS > 0 && puData.cycleTimeS > 0
    ? ((puData.cycleTimeS - puData.cycleTargetS) / puData.cycleTargetS) * 100
    : 0;
  const cycleColor = cycleDeviation > 10 ? '#D0021B' : cycleDeviation > 5 ? '#F5A623' : undefined;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
        <Box sx={{
          width: 8, height: 8, borderRadius: '50%',
          bgcolor: stateColor, flexShrink: 0,
        }} />
        <Typography
          variant="subtitle2"
          sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
        >
          {data.nodePath.split('/').pop() ?? 'Processing Unit'}
        </Typography>
        <Typography variant="caption" sx={{ color: stateColor, fontSize: 10, fontWeight: 600, ml: 'auto' }}>
          {stateLabel}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Processing Unit
      </Typography>

      {hasOee && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mb: 0.25 }}>
            <Typography sx={{ color: oeeColor, fontWeight: 700, fontSize: 16, fontFamily: 'monospace', lineHeight: 1 }}>
              {puData.oeePercent.toFixed(1)}%
            </Typography>
            <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 600, letterSpacing: 0.5 }}>
              OEE
            </Typography>
          </Box>
          <OeeBar
            availability={puData.availability}
            performance={puData.performance}
            quality={puData.quality}
          />
          <Row label="Availability" value={`${(puData.availability * 100).toFixed(1)}%`} />
          <Row label="Performance"  value={`${(puData.performance * 100).toFixed(1)}%`} />
          <Row label="Quality"      value={`${(puData.quality * 100).toFixed(1)}%`} />
        </>
      )}

      {(puData.cycleTimeS > 0 || puData.cycleTargetS > 0) && (
        <Row
          label="Cycle"
          value={
            puData.cycleTargetS > 0
              ? `${puData.cycleTimeS.toFixed(1)} / ${puData.cycleTargetS.toFixed(1)} s`
              : `${puData.cycleTimeS.toFixed(1)} s`
          }
          color={cycleColor}
        />
      )}
      {puData.throughputPerHour > 0 && (
        <Row label="Throughput" value={`${puData.throughputPerHour.toFixed(0)} /h`} />
      )}
      {puData.totalCount > 0 && (
        <>
          <Row label="Good" value={puData.goodCount.toString()} />
          <Row label="Scrap" value={puData.scrapCount.toString()} color={puData.scrapCount > 0 ? '#F5A623' : undefined} />
          <Row label="Yield" value={`${qualityYield.toFixed(1)}%`} />
        </>
      )}
      {puData.mtbfHours > 0 && (
        <Row label="MTBF" value={`${puData.mtbfHours.toFixed(1)} h`} />
      )}
      {puData.mttrMinutes > 0 && (
        <Row label="MTTR" value={`${puData.mttrMinutes.toFixed(1)} min`} />
      )}
      {(puData.runHours > 0 || puData.downHours > 0) && (
        <Row
          label="Up / Down"
          value={`${puData.runHours.toFixed(1)} / ${puData.downHours.toFixed(1)} h`}
        />
      )}
      {puData.lastFault && (
        <Row label="Last Fault" value={puData.lastFault} color="#F5A623" />
      )}
    </>
  );
}

// ── Self-registration (content provider only) ──
// The data resolver for 'processing-unit' is registered by the RVProcessingUnit
// class module via registerTooltipComponent() — single source of truth.
tooltipRegistry.register({
  contentType: 'processing-unit',
  component: ProcessingUnitTooltipContent as any,
});
