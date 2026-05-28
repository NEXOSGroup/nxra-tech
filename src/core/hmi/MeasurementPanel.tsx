// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MeasurementPanel — Left-panel section showing all measurements.
 *
 * Displays a scrollable list of measurements with click-to-focus,
 * inline name editing, visibility toggle, and delete functionality.
 */

import { useSyncExternalStore, useCallback, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Divider,
  Paper,
  TextField,
} from '@mui/material';
import {
  Close,
  Delete,
  Visibility,
  VisibilityOff,
  CenterFocusStrong,
  DeleteSweep,
  Straighten,
} from '@mui/icons-material';
import { ToggleButton, ToggleButtonGroup, Slider } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import type { MeasurementPluginAPI, Measurement } from '../types/plugin-types';
import {
  subscribeMeasurements,
  getMeasurementSnapshot,
} from '../../plugins/measurement-plugin';
import { formatDistance } from '../../plugins/rv-measurement-renderer';
import type { MeasurementUnit } from '../../plugins/rv-measurement-renderer';
import type { MeasurementPlugin as MeasurementPluginType, MeasureAxisLock } from '../../plugins/measurement-plugin';
import {
  LEFT_PANEL_TOP,
  LEFT_PANEL_LEFT,
  LEFT_PANEL_BOTTOM,
  LEFT_PANEL_ZINDEX,
} from './layout-constants';
import { useMobileLayout } from '../../hooks/use-mobile-layout';

// ── Constants ──────────────────────────────────────────────────────────

const PANEL_WIDTH = 280;
const BG = 'rgba(18,22,30,0.96)';
const BORDER = 'rgba(255,255,255,0.07)';

// ── Panel Component ────────────────────────────────────────────────────

export function MeasurementPanel() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeMeasurements, getMeasurementSnapshot);
  const plugin = viewer.getPlugin('measurements') as MeasurementPluginAPI | undefined;

  const lpm = viewer.leftPanelManager;
  const isOpen = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot).activePanel === 'measurements';

  const isMobile = useMobileLayout();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [unit, setUnit] = useState<MeasurementUnit>('auto');
  const [displayScale, setDisplayScale] = useState(1.0);

  const handleScaleChange = useCallback((_: unknown, v: number | number[]) => {
    const val = typeof v === 'number' ? v : v[0];
    setDisplayScale(val);
    const mp = viewer.getPlugin('measurements') as MeasurementPluginType | undefined;
    if (mp) {
      (mp as any)._renderer?.setDisplayScale?.(val);
      viewer.markRenderDirty();
    }
  }, [viewer]);

  const handleAxisLock = useCallback((_: unknown, v: MeasureAxisLock | null) => {
    if (!v) return;
    const mp = viewer.getPlugin('measurements') as MeasurementPluginType | undefined;
    if (mp) mp.axisLock = v;
  }, [viewer]);

  const handleUnitChange = useCallback((_: unknown, v: MeasurementUnit | null) => {
    if (!v) return;
    setUnit(v);
    // Propagate to renderer so 3D labels update
    const mp = viewer.getPlugin('measurements') as MeasurementPluginType | undefined;
    if (mp) {
      (mp as any)._renderer?.setUnit?.(v);
      // Force re-render all labels
      for (const m of snap.measurements) {
        (mp as any)._renderer?.updateMeasurement?.(m);
      }
      viewer.markRenderDirty();
    }
  }, [viewer, snap.measurements]);

  const handleClose = useCallback(() => {
    lpm.close('measurements');
    if (plugin) plugin.measurementMode = false;
  }, [lpm, plugin]);

  const handleDelete = useCallback((id: string) => {
    plugin?.removeMeasurement(id);
  }, [plugin]);

  const handleFocus = useCallback((id: string) => {
    plugin?.focusMeasurement(id);
  }, [plugin]);

  const handleToggleVisibility = useCallback((m: Measurement) => {
    plugin?.updateMeasurement(m.id, { visible: !m.visible });
  }, [plugin]);

  const handleClearAll = useCallback(() => {
    plugin?.removeAll();
  }, [plugin]);

  const handleStartEdit = useCallback((m: Measurement) => {
    setEditingId(m.id);
    setEditName(m.name);
  }, []);

  const handleFinishEdit = useCallback(() => {
    if (editingId && editName.trim()) {
      plugin?.updateMeasurement(editingId, { name: editName.trim() });
    }
    setEditingId(null);
  }, [editingId, editName, plugin]);

  // On mobile, don't show the panel — measurement mode still works via
  // the 3D labels directly on the model surface.
  if (!isOpen || !plugin || isMobile) return null;

  return (
    <Paper
      elevation={6}
      data-ui-panel
      sx={{
        position: 'fixed',
        left: LEFT_PANEL_LEFT,
        top: LEFT_PANEL_TOP,
        bottom: LEFT_PANEL_BOTTOM,
        width: PANEL_WIDTH,
        bgcolor: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 1,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', p: 1, gap: 0.5 }}>
        <Straighten sx={{ fontSize: 14, color: '#4fc3f7' }} />
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', flexGrow: 1 }}>
          Measurements ({snap.measurements.length})
        </Typography>
        {snap.measurements.length > 0 && (
          <>
            <IconButton
              size="small"
              onClick={() => {
                const allVisible = snap.measurements.every(m => m.visible);
                for (const m of snap.measurements) plugin?.updateMeasurement(m.id, { visible: !allVisible });
              }}
              sx={{ color: 'rgba(255,255,255,0.3)', p: 0.25, '&:hover': { color: '#4fc3f7' } }}
              title={snap.measurements.every(m => m.visible) ? 'Hide all' : 'Show all'}
            >
              {snap.measurements.every(m => m.visible)
                ? <Visibility sx={{ fontSize: 14 }} />
                : <VisibilityOff sx={{ fontSize: 14 }} />}
            </IconButton>
            <IconButton
              size="small"
              onClick={handleClearAll}
              sx={{ color: 'rgba(255,255,255,0.3)', p: 0.25, '&:hover': { color: '#ef5350' } }}
              title="Clear all"
            >
              <DeleteSweep sx={{ fontSize: 14 }} />
            </IconButton>
          </>
        )}
        <IconButton size="small" onClick={handleClose} sx={{ color: 'rgba(255,255,255,0.4)', p: 0.25 }}>
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      <Divider sx={{ borderColor: BORDER }} />

      {/* Unit + Axis lock toggles */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, py: 0.5 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={unit}
          onChange={handleUnitChange}
          sx={{
            '& .MuiToggleButton-root': {
              fontSize: 10, py: 0.15, px: 0.8, textTransform: 'none',
              color: 'rgba(255,255,255,0.5)', borderColor: 'rgba(255,255,255,0.1)',
              '&.Mui-selected': { color: '#4fc3f7', bgcolor: 'rgba(79,195,247,0.1)' },
            },
          }}
        >
          <ToggleButton value="auto">Auto</ToggleButton>
          <ToggleButton value="mm">mm</ToggleButton>
          <ToggleButton value="m">m</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={snap.axisLock}
          onChange={handleAxisLock}
          sx={{
            '& .MuiToggleButton-root': {
              fontSize: 10, py: 0.15, px: 0.6, textTransform: 'none',
              color: 'rgba(255,255,255,0.5)', borderColor: 'rgba(255,255,255,0.1)',
              '&.Mui-selected.axis-x': { color: '#ef5350', bgcolor: 'rgba(239,83,80,0.15)' },
              '&.Mui-selected.axis-y': { color: '#66bb6a', bgcolor: 'rgba(102,187,106,0.15)' },
              '&.Mui-selected.axis-z': { color: '#42a5f5', bgcolor: 'rgba(66,165,245,0.15)' },
              '&.Mui-selected.axis-none': { color: '#4fc3f7', bgcolor: 'rgba(79,195,247,0.1)' },
            },
          }}
        >
          <ToggleButton value="none" className="axis-none">3D</ToggleButton>
          <ToggleButton value="x" className="axis-x">X</ToggleButton>
          <ToggleButton value="y" className="axis-y">Y</ToggleButton>
          <ToggleButton value="z" className="axis-z">Z</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Display size slider */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, gap: 1, pb: 0.5 }}>
        <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>Size</Typography>
        <Slider
          size="small"
          min={0.3}
          max={3.0}
          step={0.1}
          value={displayScale}
          onChange={handleScaleChange}
          sx={{
            color: '#4fc3f7',
            '& .MuiSlider-thumb': { width: 10, height: 10 },
            '& .MuiSlider-track': { height: 2 },
            '& .MuiSlider-rail': { height: 2, opacity: 0.2 },
          }}
        />
      </Box>

      {/* Measurement list */}
      <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {snap.measurements.length === 0 && (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
            Click two points on surfaces to measure distance
          </Typography>
        )}
        {snap.measurements.map((m) => (
          <Box
            key={m.id}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.5,
              px: 1,
              py: 0.5,
              cursor: 'pointer',
              opacity: m.visible ? 1 : 0.4,
              '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
            }}
            onClick={() => handleFocus(m.id)}
          >
            {/* Color dot */}
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: m.color,
                flexShrink: 0,
                mt: 0.5,
              }}
            />

            {/* Name + Distance */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {editingId === m.id ? (
                <TextField
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleFinishEdit}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFinishEdit(); }}
                  autoFocus
                  size="small"
                  variant="standard"
                  sx={{
                    '& .MuiInputBase-input': { fontSize: 11, color: 'rgba(255,255,255,0.85)', p: 0 },
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <Typography
                  sx={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.85)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: 'text',
                  }}
                  onDoubleClick={(e) => { e.stopPropagation(); handleStartEdit(m); }}
                >
                  {m.name}
                </Typography>
              )}
              <Typography sx={{ fontSize: 10, color: '#4fc3f7', fontWeight: 600 }}>
                {formatDistance(m.distance, unit)}
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, mt: 0.2 }}>
                <Typography sx={{ fontSize: 9, color: '#ef5350' }}>
                  ΔX {formatDistance(Math.abs(m.pointB[0] - m.pointA[0]), unit)}
                </Typography>
                <Typography sx={{ fontSize: 9, color: '#66bb6a' }}>
                  ΔY {formatDistance(Math.abs(m.pointB[1] - m.pointA[1]), unit)}
                </Typography>
                <Typography sx={{ fontSize: 9, color: '#42a5f5' }}>
                  ΔZ {formatDistance(Math.abs(m.pointB[2] - m.pointA[2]), unit)}
                </Typography>
              </Box>
            </Box>

            {/* Actions */}
            <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0 }}>
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); handleToggleVisibility(m); }}
                sx={{ color: 'rgba(255,255,255,0.3)', p: 0.2, '&:hover': { color: '#4fc3f7' } }}
              >
                {m.visible ? <Visibility sx={{ fontSize: 12 }} /> : <VisibilityOff sx={{ fontSize: 12 }} />}
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); handleFocus(m.id); }}
                sx={{ color: 'rgba(255,255,255,0.3)', p: 0.2, '&:hover': { color: '#4fc3f7' } }}
              >
                <CenterFocusStrong sx={{ fontSize: 12 }} />
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); handleDelete(m.id); }}
                sx={{ color: 'rgba(255,255,255,0.3)', p: 0.2, '&:hover': { color: '#ef5350' } }}
              >
                <Delete sx={{ fontSize: 12 }} />
              </IconButton>
            </Box>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
