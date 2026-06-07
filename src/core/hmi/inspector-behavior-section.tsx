// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BehaviorLiveStateSections — appended to the inspector card of any component
 * whose capability is registered with `filterLabel: 'Behavior'` (Conveyor,
 * Turntable, ChainTransfer, …). Shows three live read-only sections scoped to
 * the LayoutObject root that owns the behavior:
 *
 *   • SIGNALS   — every `${rootName}/...` entry in the signal store
 *   • HARDWARE  — drives + sensors in the subtree with live speed / direction / occupied
 *   • SNAPS     — per-snap row (flow, paired vs free)
 *
 * Re-renders on the inspector's existing `useSignalTick` cadence — no extra pump.
 */

import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import { useSignalTick } from '../../hooks/use-signal-tick';
import { isPlacedLibraryAsset } from './layout-root-utils';

// ─── Minimal viewer-shape contracts (tested without a real viewer) ──────
export interface BehaviorViewerSnapshot {
  drives: ReadonlyArray<{ name: string; node: Object3D }>;
  transportManager: { sensors: ReadonlyArray<{ node: Object3D }> } | null;
  signalStore: { getAll(): ReadonlyMap<string, boolean | number> } | null;
  getPlugin?<T>(id: string): T | undefined;
}

export interface BehaviorSnapInfo {
  id: string;
  flow: 'in' | 'out' | 'bidi';
  paired: boolean;
}

export interface BehaviorRowData {
  signalNames: string[];
  driveNames: string[];
  sensorNames: string[];
  snaps: BehaviorSnapInfo[];
}

// ─── Pure data collection (testable) ────────────────────────────────────

function ancestorOrSelfIs(node: Object3D | null, target: Object3D): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    if (cur === target) return true;
    cur = cur.parent;
  }
  return false;
}

export function collectBehaviorData(viewer: BehaviorViewerSnapshot, root: Object3D): BehaviorRowData {
  const out: BehaviorRowData = { signalNames: [], driveNames: [], sensorNames: [], snaps: [] };

  if (viewer.signalStore) {
    const prefix = `${root.name}/`;
    for (const name of viewer.signalStore.getAll().keys()) {
      if (name.startsWith(prefix)) out.signalNames.push(name);
    }
    out.signalNames.sort();
  }

  for (const d of viewer.drives) {
    if (ancestorOrSelfIs(d.node, root)) out.driveNames.push(d.name);
  }

  for (const s of viewer.transportManager?.sensors ?? []) {
    if (ancestorOrSelfIs(s.node, root)) {
      out.sensorNames.push(s.node.name || '<sensor>');
    }
  }

  type SnapRegistryShape = {
    getByOwnerRoot(r: Object3D): readonly { id: string; flow: 'in' | 'out' | 'bidi'; pairedSnapId?: string }[];
  };
  const snapPlugin = viewer.getPlugin?.<{ getRegistry?: () => SnapRegistryShape }>('snap-point');
  const reg = snapPlugin?.getRegistry?.();
  if (reg) {
    for (const sp of reg.getByOwnerRoot(root)) {
      out.snaps.push({ id: sp.id, flow: sp.flow, paired: !!sp.pairedSnapId });
    }
  }

  return out;
}

// ─── Component ──────────────────────────────────────────────────────────

interface Props {
  viewer: RVViewer;
  layoutRoot: Object3D;
}

export function BehaviorLiveStateSections({ viewer, layoutRoot }: Props) {
  // Tick-driven re-render on signal changes (same cadence the inspector uses).
  useSignalTick(viewer.signalStore ?? null, 200);

  if (!isPlacedLibraryAsset(layoutRoot)) return null;

  const data = useMemo(
    () => collectBehaviorData(viewer as unknown as BehaviorViewerSnapshot, layoutRoot),
    // Re-collect every signal tick — cheap (handful of map ops); avoids stale
    // signal/drive/sensor lists when the viewer adds new entries after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, layoutRoot, viewer.signalStore?.getAll().size, viewer.drives.length],
  );

  const signalValues = viewer.signalStore?.getAll();
  const live = (viewer as unknown as BehaviorViewerSnapshot);

  if (data.signalNames.length === 0 && data.driveNames.length === 0 && data.sensorNames.length === 0 && data.snaps.length === 0) {
    return null;
  }

  return (
    <Box sx={{ px: 1, pb: 1 }}>
      {data.signalNames.length > 0 && (
        <Section title={`SIGNALS (${data.signalNames.length})`}>
          {data.signalNames.map(name => {
            const v = signalValues?.get(name);
            return <Row key={name} k={name.split('/').slice(-1)[0]} v={formatValue(v)} hot={v === true} />;
          })}
        </Section>
      )}

      {(data.driveNames.length > 0 || data.sensorNames.length > 0) && (
        <Section title="HARDWARE">
          {data.driveNames.map(name => {
            const d = (viewer.drives as ReadonlyArray<unknown>).find(x => (x as { name: string }).name === name) as
              | { jogForward?: boolean; jogBackward?: boolean; currentSpeed?: number }
              | undefined;
            const dir = d?.jogForward ? '►' : d?.jogBackward ? '◄' : '·';
            return <Row key={`d-${name}`} k={`drv ${name}`} v={`${dir}  ${d ? (d.currentSpeed ?? 0).toFixed(0) : '?'} mm/s`} hot={!!d?.jogForward} />;
          })}
          {data.sensorNames.map(name => {
            const s = (live.transportManager?.sensors as ReadonlyArray<unknown> | undefined)?.find(
              x => ((x as { node: { name: string } }).node.name === name),
            ) as { occupied?: boolean } | undefined;
            const occ = s?.occupied === true;
            return <Row key={`s-${name}`} k={`sns ${name}`} v={occ ? 'OCCUPIED' : 'clear'} hot={occ} />;
          })}
        </Section>
      )}

      {data.snaps.length > 0 && (
        <Section title={`SNAPS (${data.snaps.filter(s => s.paired).length}/${data.snaps.length} paired)`}>
          {data.snaps.map(s => (
            <Row key={s.id} k={s.flow} v={s.paired ? 'paired' : 'free'} hot={!s.paired && s.flow === 'out'} dim={!s.paired} />
          ))}
        </Section>
      )}
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 0.75 }}>
      <Typography sx={{ fontSize: 9, color: 'text.disabled', letterSpacing: 0.6, fontWeight: 700 }}>{title}</Typography>
      <Box sx={{ mt: 0.25 }}>{children}</Box>
    </Box>
  );
}

function Row({ k, v, hot, dim }: { k: string; v: string; hot?: boolean; dim?: boolean }) {
  return (
    <Box sx={{
      display: 'flex', justifyContent: 'space-between', gap: 1,
      fontSize: 11, fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      color: dim ? 'text.disabled' : 'text.secondary',
      px: 0.5,
    }}>
      <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</Box>
      <Box sx={{ color: hot ? '#e8b04a' : 'inherit', fontWeight: hot ? 700 : 400 }}>{v}</Box>
    </Box>
  );
}

function formatValue(v: boolean | number | undefined): string {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
