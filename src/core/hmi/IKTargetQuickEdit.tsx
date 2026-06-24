// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * IKTargetQuickEdit — Content for the IK pathpoint context popover.
 *
 * Pure content (no positioning): the generic AnchoredPopover supplies the floating
 * glass shell. Reads/edits the active IKTarget via ikEditStore (fed by
 * IKTargetEditPlugin). Self-registers under id 'ik-target'.
 */

import { useSyncExternalStore } from 'react';
import { Box, Typography, IconButton, Tooltip, Divider } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ikEditStore, type IKEditValues } from './ik-edit-store';
import { EnumEditor, NumberEditor, BooleanEditor } from './rv-field-editors';
import { popoverContentRegistry } from './popover-store';

const INTERP = ['PointToPoint', 'PointToPointUnsynced', 'Linear'];
const INTERP_LABEL: Record<string, string> = { PointToPoint: 'PTP', PointToPointUnsynced: 'PTP-unsync', Linear: 'Linear' };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', minWidth: 78 }}>{label}</Typography>
      <Box sx={{ flex: 1 }}>{children}</Box>
    </Box>
  );
}

function ActionBtn({ label, color, onClick }: { label: string; color?: string; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        fontSize: 10, px: 0.75, py: 0.4, borderRadius: 0.5, cursor: 'pointer', textAlign: 'center', flex: 1,
        bgcolor: 'rgba(255,255,255,0.06)', color: color ?? '#fff', whiteSpace: 'nowrap',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.14)' },
      }}
    >{label}</Box>
  );
}

function IKTargetQuickEdit() {
  const active = useSyncExternalStore(ikEditStore.subscribe, ikEditStore.getSnapshot);
  if (!active) return null;
  const ctl = ikEditStore.getController();
  if (!ctl) return null;
  const set = <K extends keyof IKEditValues>(k: K, v: IKEditValues[K]) => ctl.setProp(k, v);
  const isLinear = active.interpolation === 'Linear';

  return (
    <Box sx={{ width: 230 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: active.reachable ? '#5dd55d' : '#ff5d5d', boxShadow: `0 0 6px ${active.reachable ? '#5dd55d' : '#ff5d5d'}` }} />
        <Typography sx={{ fontSize: 12, fontWeight: 700, color: '#ce93d8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</Typography>
        <Tooltip title="Schließen" placement="top">
          <IconButton size="small" onClick={() => ctl.close()} sx={{ p: 0.25 }}><CloseIcon sx={{ fontSize: 14 }} /></IconButton>
        </Tooltip>
      </Box>

      <Row label="Interpolation"><EnumEditor value={active.interpolation} options={INTERP} onChange={(v) => set('interpolation', v)} /></Row>
      <Row label="Speed"><NumberEditor value={active.speedToTarget} onChange={(v) => set('speedToTarget', v)} /></Row>
      {isLinear && <Row label="Lin. Speed"><NumberEditor value={active.linearSpeed} onChange={(v) => set('linearSpeed', v)} /></Row>}
      {isLinear && <Row label="Lin. Accel"><NumberEditor value={active.linearAccel} onChange={(v) => set('linearAccel', v)} /></Row>}
      <Row label="Blending"><BooleanEditor value={active.enableBlending} onChange={(v) => set('enableBlending', v)} /></Row>
      {active.enableBlending && <Row label="Blend R."><NumberEditor value={active.blendRadius} onChange={(v) => set('blendRadius', v)} /></Row>}
      <Row label="Wait (s)"><NumberEditor value={active.waitForSeconds} onChange={(v) => set('waitForSeconds', v)} /></Row>
      <Row label="Pick&Place"><BooleanEditor value={active.pickAndPlace} onChange={(v) => set('pickAndPlace', v)} /></Row>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', my: 0.75 }} />
      <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5 }}>
        <ActionBtn label="+ davor" onClick={() => ctl.addPoint('before')} />
        <ActionBtn label="+ danach" onClick={() => ctl.addPoint('after')} />
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <ActionBtn label="Hierher fahren" onClick={() => ctl.driveHere()} />
        <ActionBtn label="Löschen" color="#ff8080" onClick={() => ctl.deleteTarget()} />
      </Box>
      <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', mt: 0.5 }}>
        {INTERP_LABEL[active.interpolation] ?? active.interpolation} · {active.reachable ? 'erreichbar' : 'nicht erreichbar'}
      </Typography>
    </Box>
  );
}

// Self-register as the 'ik-target' popover content.
popoverContentRegistry.register('ik-target', IKTargetQuickEdit);
