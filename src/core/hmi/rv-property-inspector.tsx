// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PropertyInspector — Editable property panel for the selected hierarchy node.
 *
 * Shows component properties grouped by type (Drive, Sensor, TransportSurface, etc.).
 * - CONSUMED fields: editable with appropriate widgets
 * - IGNORED / unknown fields: read-only, grayed out with "Not used" tooltip
 * - Override indicators: blue dot for fields that differ from GLB defaults
 * - Per-field and per-node reset to GLB defaults
 * - LogicStep runtime status section (state, progress, cycle stats)
 *
 * Positioned to the right of the hierarchy panel when a node is selected.
 *
 * Sub-modules:
 * - rv-inspector-helpers.ts  — Pure functions + constants (shared with hierarchy browser)
 * - rv-field-editors.tsx     — Inline editor widgets (Number, Boolean, Enum, etc.)
 * - rv-reference-display.tsx — ComponentReference and ScriptableObject badges
 * - rv-field-row.tsx         — Single field row component
 * - rv-component-section.tsx — Collapsible component section
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSignalTick } from '../../hooks/use-signal-tick';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { MathUtils } from 'three';
import type { Object3D } from 'three';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Button,
  Chip,
  LinearProgress,
} from '@mui/material';
import {
  RestartAlt,
  FilterList,
  Lock,
  LockOpen,
  SwapHoriz,
  OpenInNew,
  PushPin,
  Visibility,
  VisibilityOff,
} from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { LayoutPlannerPlugin } from '../../plugins/layout-planner';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import { getOverriddenFields } from '../engine/rv-extras-overlay-store';
import { USER_PAUSE_REASON } from '../engine/rv-constants';
import { LeftPanel } from './LeftPanel';
import { AasDetailHeaderAction } from '../../plugins/aas-link-plugin';
import { ChartPanel } from './ChartPanel';
import { INSPECTOR_PANEL_WIDTH } from './layout-constants';
import {
  isHiddenComponentType,
  componentColor,
  type ReverseReference,
} from './rv-inspector-helpers';
import { getPrimaryDisplayValue, applyLiveEdit, getLiveStateFor, formatValue } from './rv-value-resolver';
import { navigateToRef } from './rv-reference-display';
import { ComponentSection } from './rv-component-section';
import { Vector3Editor } from './rv-field-editors';
import { StepState } from '../engine/rv-logic-step';
import type { StepStateInfo } from '../engine/rv-logic-engine';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';

// Re-export isHiddenComponentType for backward compatibility
export { isHiddenComponentType } from './rv-inspector-helpers';

// ── Consumed-only filter persistence ────────────────────────────────────

const LS_KEY_CONSUMED_ONLY = 'rv-inspector-consumed-only';
const LS_KEY_DETACHED = 'rv-inspector-detached';

function loadConsumedOnly(): boolean {
  try { return localStorage.getItem(LS_KEY_CONSUMED_ONLY) === 'true'; }
  catch { return false; }
}

function loadDetached(): boolean {
  try { return localStorage.getItem(LS_KEY_DETACHED) === 'true'; }
  catch { return false; }
}

// ── LogicStep Runtime Section ─────────────────────────────────────────────

interface RuntimeFieldRowProps {
  label: string;
  value: string;
  color?: string;
}

function RuntimeFieldRow({ label, value, color }: RuntimeFieldRowProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.15 }}>
      <Typography sx={{ fontSize: 10, color: 'text.disabled', width: 100, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 10, color: color ?? 'text.primary', fontWeight: 500 }}>
        {value}
      </Typography>
    </Box>
  );
}

/** Accent color for the read-only live-state section (distinct from config). */
const LIVE_STATE_COLOR = '#4dd0e1';

/** Read-only "Live State" section showing the actual runtime values of the
 *  selected node's live components (Drive, Sensor, TransportSurface). These are
 *  NEVER editable or overridable — runtime state belongs to the simulation, not
 *  the saved scene. Returns null when the node has no live component. */
function LiveStateSection({ viewer, nodePath, componentTypes }: {
  viewer: RVViewer;
  nodePath: string;
  componentTypes: readonly string[];
}) {
  const groups: Array<{ type: string; fields: Array<[string, unknown]> }> = [];
  for (const type of componentTypes) {
    const live = getLiveStateFor(viewer, nodePath, type);
    if (live) {
      const fields = Object.entries(live);
      if (fields.length > 0) groups.push({ type, fields });
    }
  }
  if (groups.length === 0) return null;
  const showTypeLabel = groups.length > 1;

  return (
    <Box sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1,
          py: 0.5,
          bgcolor: LIVE_STATE_COLOR + '18',
          borderBottom: `2px solid ${LIVE_STATE_COLOR}44`,
        }}
      >
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: LIVE_STATE_COLOR, mr: 0.75, flexShrink: 0 }} />
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: LIVE_STATE_COLOR, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Live State
        </Typography>
        <Typography sx={{ fontSize: 9, color: LIVE_STATE_COLOR, fontWeight: 600 }}>
          read-only
        </Typography>
      </Box>
      <Box sx={{ py: 0.5 }}>
        {groups.map(({ type, fields }) => (
          <Box key={type}>
            {showTypeLabel && (
              <Typography sx={{ fontSize: 9, color: 'text.disabled', px: 1, pt: 0.25, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {type}
              </Typography>
            )}
            {fields.map(([k, v]) => (
              <RuntimeFieldRow key={k} label={k} value={formatValue(v, { boolStyle: 'word' })} />
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function LogicStepRuntimeSection({ info }: { info: StepStateInfo }) {
  const stateColor = STEP_STATE_COLORS[info.state];
  const stateLabel = STEP_STATE_LABELS[info.state];

  return (
    <Box sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
      {/* Section header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1,
          py: 0.5,
          bgcolor: stateColor + '18',
          borderBottom: `2px solid ${stateColor}44`,
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: stateColor,
            mr: 0.75,
            flexShrink: 0,
          }}
        />
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: stateColor, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Runtime Status
        </Typography>
        <Typography sx={{ fontSize: 9, color: stateColor, fontWeight: 600 }}>
          {stateLabel}
        </Typography>
      </Box>

      {/* Runtime fields */}
      <Box sx={{ py: 0.5 }}>
        <RuntimeFieldRow label="State" value={info.state} color={stateColor} />
        <RuntimeFieldRow label="Type" value={info.type} />

        {/* Progress bar */}
        <Box sx={{ px: 1, py: 0.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontSize: 10, color: 'text.disabled', width: 100, flexShrink: 0 }}>
              Progress
            </Typography>
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, info.progress)}
                sx={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  bgcolor: 'rgba(255,255,255,0.06)',
                  '& .MuiLinearProgress-bar': { bgcolor: stateColor, borderRadius: 2 },
                }}
              />
              <Typography sx={{ fontSize: 9, color: 'text.secondary', minWidth: 28, textAlign: 'right' }}>
                {info.progress.toFixed(0)}%
              </Typography>
            </Box>
          </Box>
        </Box>

        {/* SerialContainer-specific fields */}
        {info.type === 'SerialContainer' && (
          <>
            {info.currentIndex !== undefined && info.childCount !== undefined && (
              <RuntimeFieldRow label="Current Step" value={`${info.currentIndex + 1} / ${info.childCount}`} />
            )}
            {info.completedCycles !== undefined && (
              <RuntimeFieldRow label="Completed Cycles" value={info.completedCycles.toString()} />
            )}
            {info.minCycleTime !== undefined && info.minCycleTime > 0 && (
              <RuntimeFieldRow label="Min Cycle Time" value={`${info.minCycleTime.toFixed(3)}s`} />
            )}
            {info.maxCycleTime !== undefined && info.maxCycleTime > 0 && (
              <RuntimeFieldRow label="Max Cycle Time" value={`${info.maxCycleTime.toFixed(3)}s`} />
            )}
            {info.medianCycleTime !== undefined && info.medianCycleTime > 0 && (
              <RuntimeFieldRow label="Median Cycle Time" value={`${info.medianCycleTime.toFixed(3)}s`} />
            )}
          </>
        )}

        {/* ParallelContainer-specific fields */}
        {info.type === 'ParallelContainer' && info.finishedCount !== undefined && info.childCount !== undefined && (
          <RuntimeFieldRow label="Finished" value={`${info.finishedCount} / ${info.childCount}`} />
        )}

        {/* Delay-specific fields */}
        {info.type === 'Delay' && info.elapsed !== undefined && info.duration !== undefined && (
          <RuntimeFieldRow label="Elapsed" value={`${info.elapsed.toFixed(2)}s / ${info.duration.toFixed(2)}s`} />
        )}
      </Box>
    </Box>
  );
}

// ── Layout Transform Section ─────────────────────────────────────────────

interface LayoutTransformSectionProps {
  // Re-declared inline so this section is self-contained; viewer + nodePath
  // are required for transform read/write, the rest are inspector-level
  // wiring callbacks.
  viewer: RVViewer;
  nodePath: string;
  locked: boolean;
  onToggleLock?: () => void;
  /** Toggle for the universal Visible flag — rendered next to the lock
   *  icon in the section header. Receives the new desired value. */
  onToggleVisible?: (next: boolean) => void;
  /** Reverse-direction action — rotates the asset 180° around its
   *  connected snap-point's outward axis. Only shown when the asset is
   *  part of at least one paired snap-point chain. */
  onReverseDirection?: () => void;
  /** Whether the asset has any paired snap (= the Reverse button should
   *  be enabled). When false the button is hidden entirely. */
  canReverse?: boolean;
}

function LayoutTransformSection({ viewer, nodePath, locked, onToggleLock, onToggleVisible, onReverseDirection, canReverse }: LayoutTransformSectionProps) {
  const node = viewer.registry?.getNode(nodePath);

  // Poll position/rotation at 200ms for live updates (e.g. during TransformControls drag)
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  useEffect(() => {
    const id = setInterval(() => { tickRef.current++; setTick(tickRef.current); }, 200);
    return () => clearInterval(id);
  }, []);

  const pos = useMemo(() => {
    if (!node) return { x: 0, y: 0, z: 0 };
    return { x: +node.position.x.toFixed(4), y: +node.position.y.toFixed(4), z: +node.position.z.toFixed(4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, tick]);

  const rot = useMemo(() => {
    if (!node) return { x: 0, y: 0, z: 0 };
    return {
      x: +MathUtils.radToDeg(node.rotation.x).toFixed(2),
      y: +MathUtils.radToDeg(node.rotation.y).toFixed(2),
      z: +MathUtils.radToDeg(node.rotation.z).toFixed(2),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, tick]);

  const emitTransformUpdate = useCallback(() => {
    if (!node) return;
    // Auto-stop the simulation when the user changes a layout object's
    // transform. Uses the user-owned pause reason so Play / Space resumes it.
    viewer.setSimulationPaused?.(USER_PAUSE_REASON, true);
    viewer.markRenderDirty();
    viewer.emit('layout-transform-update', {
      path: nodePath,
      position: [node.position.x, node.position.y, node.position.z] as [number, number, number],
      rotation: [
        MathUtils.radToDeg(node.rotation.x),
        MathUtils.radToDeg(node.rotation.y),
        MathUtils.radToDeg(node.rotation.z),
      ] as [number, number, number],
    });
  }, [node, nodePath, viewer]);

  const handlePositionChange = useCallback((v: { x: number; y: number; z: number }) => {
    if (!node || locked) return;
    node.position.set(v.x, v.y, v.z);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleRotationChange = useCallback((v: { x: number; y: number; z: number }) => {
    if (!node || locked) return;
    node.rotation.set(MathUtils.degToRad(v.x), MathUtils.degToRad(v.y), MathUtils.degToRad(v.z));
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleResetPosition = useCallback(() => {
    if (!node || locked) return;
    node.position.set(0, 0, 0);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleResetRotation = useCallback(() => {
    if (!node || locked) return;
    node.rotation.set(0, 0, 0);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  if (!node) return null;

  const fieldRowSx = { display: 'flex', alignItems: 'center', px: 1, py: 0.25 };
  const labelSx = { fontSize: 10, color: locked ? 'text.disabled' : 'text.secondary', width: 52, flexShrink: 0, cursor: 'default' };
  const resetBtnSx = { p: 0.15, color: 'text.disabled', flexShrink: 0, '&:hover': { color: '#ffa726' } };

  return (
    <Box sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5, bgcolor: 'rgba(100, 181, 246, 0.08)', borderBottom: '2px solid rgba(100, 181, 246, 0.2)' }}>
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: '#64b5f6', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Transform
        </Typography>
        {/* Reverse direction — rotates the asset 180° around its connected
            snap-point's outward axis. Only visible when the asset is part of
            a snap-chain (`canReverse` true). Sits before the visibility
            toggle so the most-disruptive geometric action is leftmost in the
            cluster of icons. */}
        {onReverseDirection && canReverse && (
          <Tooltip title="Reverse direction (rotate 180° around connection)">
            <IconButton
              size="small"
              onClick={onReverseDirection}
              sx={{ p: 0.25, mr: 0.25, color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
            >
              <SwapHoriz sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        {/* Visibility toggle — sits next to the lock icon so both
            object-level flags are reachable from the section header. */}
        {onToggleVisible && (
          <Tooltip title={node.visible ? 'Hide object' : 'Show object'}>
            <IconButton
              size="small"
              onClick={() => onToggleVisible(!node.visible)}
              sx={{ p: 0.25, mr: 0.25, color: node.visible ? 'primary.main' : 'text.disabled', '&:hover': { color: node.visible ? 'primary.light' : 'text.primary' } }}
            >
              {node.visible ? <Visibility sx={{ fontSize: 14 }} /> : <VisibilityOff sx={{ fontSize: 14 }} />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={locked ? 'Unlock object' : 'Lock object'}>
          <IconButton
            size="small"
            onClick={onToggleLock}
            sx={{ p: 0.25, color: locked ? '#ffa726' : 'text.secondary', '&:hover': { color: locked ? '#ffb74d' : 'text.primary' } }}
          >
            {locked ? <Lock sx={{ fontSize: 14 }} /> : <LockOpen sx={{ fontSize: 14 }} />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ py: 0.5, opacity: locked ? 0.5 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
        <Box sx={fieldRowSx}>
          <Typography sx={labelSx}>Position</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={pos} onChange={handlePositionChange} />
          </Box>
          <Tooltip title="Reset position to 0,0,0">
            <IconButton size="small" onClick={handleResetPosition} sx={resetBtnSx}>
              <RestartAlt sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={fieldRowSx}>
          <Typography sx={labelSx}>Rotation</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={rot} onChange={handleRotationChange} />
          </Box>
          <Tooltip title="Reset rotation to 0,0,0">
            <IconButton size="small" onClick={handleResetRotation} sx={resetBtnSx}>
              <RestartAlt sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export interface PropertyInspectorProps {
  viewer: RVViewer;
}

export function PropertyInspector({ viewer }: PropertyInspectorProps) {
  const { plugin, state } = useEditorPlugin();
  const selectedPath = state.selectedNodePath;

  // Find the selected node in the scene and read its userData
  const nodeData = useMemo(() => {
    if (!selectedPath || !viewer.registry) return null;

    const node = viewer.registry.getNode(selectedPath);
    if (!node) return null;

    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv) return null;

    // Collect component types and their data (skip hidden types)
    const components: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (const [key, value] of Object.entries(rv)) {
      if (isHiddenComponentType(key)) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        components.push({ type: key, data: value as Record<string, unknown> });
      }
    }

    // Detect LayoutObject for transform editing
    const layoutObj = rv.LayoutObject as Record<string, unknown> | undefined;

    return { components, layoutObj };
    // Note: state.overlay intentionally excluded — overlay changes should not re-scan node components.
    // Overlay-dependent data (overridden fields) is computed separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, viewer.registry]);

  // Check if the selected node has a LayoutObject (for transform section)
  // Re-read Locked from live userData on any state change (state is always a new ref after notify())
  const hasLayoutObject = !!nodeData?.layoutObj;
  const layoutLocked = useMemo(() => {
    if (!selectedPath || !viewer.registry) return false;
    const node = viewer.registry.getNode(selectedPath);
    const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return !!(rv?.LayoutObject?.Locked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, viewer.registry, state]);

  // Check if the selected node has a LogicStep component
  const hasLogicStep = nodeData?.components.some(c => c.type.startsWith('LogicStep_')) ?? false;

  // Get logic step runtime info
  const logicEngine = viewer.logicEngine;
  const stepInfo = hasLogicStep && logicEngine && selectedPath
    ? logicEngine.getStepInfo(selectedPath)
    : null;

  // Find reverse references: who points to this node via ComponentReference?
  // Uses the pre-built index in NodeRegistry (O(1) lookup instead of full scene scan).
  const referencedBy = useMemo<readonly ReverseReference[]>(() => {
    if (!selectedPath || !viewer.registry) return [];
    return viewer.registry.getReferencesTo(selectedPath);
  }, [selectedPath, viewer.registry]);

  // Count total overrides for this node
  const totalOverrides = useMemo(() => {
    if (!selectedPath || !state.overlay) return 0;
    const nodeOverrides = state.overlay.nodes[selectedPath];
    if (!nodeOverrides) return 0;
    let count = 0;
    for (const comp of Object.values(nodeOverrides)) {
      count += Object.keys(comp).length;
    }
    return count;
  }, [selectedPath, state.overlay]);

  const handleFieldEdit = useCallback(
    (componentType: string, fieldName: string, value: unknown) => {
      if (!selectedPath || !plugin) return;

      // Splat.Invert* / Crop* persist through the normal overlay path (same
      // as Drive.Speed etc.), but the gaussian-splat library renders splats
      // through its own pipeline and ignores the container's scale, so we
      // also push the new state into the library's splatMesh directly.
      // - Invert{X,Y,Z}     → setSplatScale (mirror via negative scale)
      // - Crop{Min,Max}{XYZ} → setSplatCrop (shader uniforms for AABB clip)
      if (componentType === 'Splat' && viewer.registry) {
        plugin.updateOverlayField(selectedPath, componentType, fieldName, value);
        const node = viewer.registry.getNode(selectedPath);
        if (node?.userData?._isSplat) {
          const splat = node.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
          const splatPlugin = viewer.getPlugin('gaussian-splat') as unknown as {
            setSplatScale?(container: import('three').Group, scale: readonly [number, number, number]): void;
            setSplatCrop?(container: import('three').Group, box: { min: readonly [number, number, number]; max: readonly [number, number, number] }): void;
          } | undefined;
          if (fieldName === 'InvertX' || fieldName === 'InvertY' || fieldName === 'InvertZ') {
            const sx = splat?.Splat?.InvertX ? -1 : 1;
            const sy = splat?.Splat?.InvertY ? -1 : 1;
            const sz = splat?.Splat?.InvertZ ? -1 : 1;
            splatPlugin?.setSplatScale?.(node as import('three').Group, [sx, sy, sz]);
          } else if (fieldName.startsWith('CropMin') || fieldName.startsWith('CropMax')) {
            const NO_CROP = 1e6;
            const num = (k: string, fallback: number): number => {
              const v = splat?.Splat?.[k];
              return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
            };
            splatPlugin?.setSplatCrop?.(node as import('three').Group, {
              min: [num('CropMinX', -NO_CROP), num('CropMinY', -NO_CROP), num('CropMinZ', -NO_CROP)],
              max: [num('CropMaxX',  NO_CROP), num('CropMaxY',  NO_CROP), num('CropMaxZ',  NO_CROP)],
            });
          }
          viewer.markRenderDirty();
        }
        return;
      }

      // Side-effect for LayoutObject.Visible/Locked: also mutate node.visible
      // so the change is immediately visible in the 3D view. The overlay
      // update below persists the value the regular way.
      if (componentType === 'LayoutObject' && viewer.registry) {
        const node = viewer.registry.getNode(selectedPath);
        if (node) {
          if (fieldName === 'Visible') {
            node.visible = !!value;
            viewer.markRenderDirty();
          }
          // Locked needs no side-effect — gizmo / drag logic reads
          // userData.realvirtual.LayoutObject.Locked directly each frame.
        }
      }

      plugin.updateOverlayField(selectedPath, componentType, fieldName, value);

      // Push the edit into the live component instance too, so a field that is
      // part of the component's live state (e.g. Drive.TargetSpeed) takes
      // effect and displays immediately instead of waiting for a scene reload.
      // No-op for non-live / non-owner components.
      applyLiveEdit(viewer, selectedPath, componentType, fieldName, value);
    },
    [plugin, selectedPath, viewer],
  );

  const handleFieldReset = useCallback(
    (componentType: string, fieldName: string) => {
      if (!selectedPath || !plugin) return;
      plugin.resetField(selectedPath, componentType, fieldName);
    },
    [plugin, selectedPath],
  );

  const handleComponentReset = useCallback(
    (componentType: string) => {
      if (!selectedPath || !plugin) return;
      plugin.resetComponent(selectedPath, componentType);
    },
    [plugin, selectedPath],
  );

  const handleResetAll = useCallback(() => {
    if (!selectedPath || !plugin) return;
    plugin.resetNode(selectedPath);
  }, [plugin, selectedPath]);

  const handleClose = useCallback(() => {
    if (!plugin) return;
    plugin.clearSelection();
  }, [plugin]);

  // Consumed-only filter: hide non-consumed (grayed-out) fields
  const [consumedOnly, setConsumedOnly] = useState(loadConsumedOnly);
  const toggleConsumedOnly = useCallback(() => {
    setConsumedOnly(prev => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_CONSUMED_ONLY, String(next)); } catch { /* */ }
      return next;
    });
  }, []);

  // Detached (floating) mode
  const [detached, setDetached] = useState(loadDetached);
  const toggleDetached = useCallback(() => {
    setDetached(prev => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_DETACHED, String(next)); } catch { /* */ }
      return next;
    });
  }, []);

  // Shared signal polling for live display in signal reference badges (consolidated via hook)
  const signalStore = viewer.signalStore;
  useSignalTick(signalStore, 200);

  // Drive/TransportSurface runtime values (position, speed) change every
  // physics frame without touching the SignalStore, so the signal tick above
  // won't refresh them. Poll at 200ms only when the selected node has such a
  // component. Sensors write to the SignalStore and refresh via the tick above.
  const hasLiveNonSignalComponent = nodeData?.components.some(
    c => c.type === 'Drive' || c.type === 'TransportSurface',
  ) ?? false;
  const [, setLiveTick] = useState(0);
  useEffect(() => {
    if (!hasLiveNonSignalComponent) return;
    const id = setInterval(() => setLiveTick(t => t + 1), 200);
    return () => clearInterval(id);
  }, [hasLiveNonSignalComponent]);

  if (!plugin || !selectedPath || !nodeData) return null;

  const nodeName = selectedPath.split('/').pop() ?? selectedPath;

  // Show runtime section only when step is not Idle (matching C# ShowIf pattern)
  const showRuntimeSection = stepInfo && stepInfo.state !== StepState.Idle;

  // ── Shared toolbar buttons ────────────────────────────────────────────
  const toolbarButtons = (
    <>
      <Tooltip title={consumedOnly ? 'Showing active fields only \u2014 click to show all' : 'Click to show only active fields'}>
        <IconButton size="small" onClick={toggleConsumedOnly} sx={{ color: consumedOnly ? '#66bb6a' : 'text.secondary', p: 0.25 }}>
          <FilterList sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={detached ? 'Dock to hierarchy panel' : 'Detach as floating window'}>
        <IconButton size="small" onClick={toggleDetached} sx={{ color: 'text.secondary', p: 0.25 }}>
          {detached ? <PushPin sx={{ fontSize: 14 }} /> : <OpenInNew sx={{ fontSize: 14 }} />}
        </IconButton>
      </Tooltip>
    </>
  );

  // ── Shared footer ─────────────────────────────────────────────────────
  const footerContent = (
    <>
      {/* Referenced by section */}
      {referencedBy.length > 0 && (
        <Box sx={{ px: 1, py: 0.75, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{ fontSize: 9, color: 'text.disabled', mb: 0.5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
            Referenced by
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {referencedBy.map((ref, i) => {
              const sourceName = ref.sourcePath.split('/').pop() ?? ref.sourcePath;
              const color = componentColor(ref.componentType);
              return (
                <Tooltip key={i} title={`${ref.sourcePath} \u2192 ${ref.fieldName}\nClick to navigate`} placement="top">
                  <Chip
                    label={`${sourceName}.${ref.fieldName}`}
                    size="small"
                    onClick={() => navigateToRef(viewer, ref.sourcePath)}
                    sx={{
                      height: 16,
                      fontSize: 9,
                      fontWeight: 500,
                      cursor: 'pointer',
                      bgcolor: color + '18',
                      color: color,
                      border: `1px solid ${color}44`,
                      '& .MuiChip-label': { px: 0.5 },
                      '&:hover': { bgcolor: color + '28' },
                    }}
                  />
                </Tooltip>
              );
            })}
          </Box>
        </Box>
      )}
      {/* Override count + Reset */}
      <Box sx={{ px: 1, py: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 10, color: 'text.disabled', flex: 1 }}>
          {totalOverrides > 0
            ? `${totalOverrides} override${totalOverrides !== 1 ? 's' : ''}`
            : 'No overrides'}
        </Typography>
        {totalOverrides > 0 && (
          <Button
            size="small"
            variant="text"
            startIcon={<RestartAlt sx={{ fontSize: 12 }} />}
            onClick={handleResetAll}
            sx={{
              fontSize: 10,
              textTransform: 'none',
              color: '#ffa726',
              py: 0,
              px: 0.5,
              minWidth: 0,
              '&:hover': { bgcolor: 'rgba(255,167,38,0.1)' },
            }}
          >
            Reset All
          </Button>
        )}
      </Box>
    </>
  );

  // ── Shared scrollable content ─────────────────────────────────────────
  const scrollContent = (
    <Box
      className={RV_SCROLL_CLASS}
      sx={{
        flex: 1,
        overflow: 'auto',
      }}
    >
      {/* LogicStep Runtime Status (above component sections, hidden when Idle) */}
      {showRuntimeSection && <LogicStepRuntimeSection info={stepInfo} />}

      {/* Live runtime state (read-only) for Drive/Sensor/TransportSurface,
          above the editable config. Never overridable or saved. */}
      <LiveStateSection
        viewer={viewer}
        nodePath={selectedPath}
        componentTypes={nodeData.components.map(c => c.type)}
      />

      {/* Layout Object Transform (position + rotation editing).
          Lock + Visibility toggles live inside its header. */}
      {hasLayoutObject && selectedPath && (
        <LayoutTransformSection
          viewer={viewer}
          nodePath={selectedPath}
          locked={layoutLocked}
          onToggleLock={() => handleFieldEdit('LayoutObject', 'Locked', !layoutLocked)}
          onToggleVisible={(next) => handleFieldEdit('LayoutObject', 'Visible', next)}
          canReverse={_canReversePlacement(viewer, selectedPath)}
          onReverseDirection={() => _doReversePlacement(viewer, selectedPath)}
        />
      )}


      {nodeData.components.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
          No component data
        </Typography>
      ) : (
        // Lock wraps the entire component edit area: when a LayoutObject is
        // locked we dim and pointer-block every nested ComponentSection so
        // no field, button, or override can be triggered. The lock toggle
        // itself lives in TRANSFORM's header (outside this wrapper) so the
        // user can still unlock.
        <Box sx={{ opacity: layoutLocked ? 0.5 : 1, pointerEvents: layoutLocked ? 'none' : 'auto' }}>
          {nodeData.components.map(({ type, data }) => {
            const overriddenFields = new Set(
              state.overlay ? getOverriddenFields(selectedPath, type, state.overlay) : [],
            );
            // Editable rows show CONFIG only (static + overlay) so the
            // override/save model stays coherent: what you see is what you
            // save. Live runtime state is shown read-only in LiveStateSection
            // below — never as an editable/overridable field.
            // Header value: a compact live glance (signal value or drive pos).
            const headerValue = getPrimaryDisplayValue(viewer, selectedPath, type, data).text;
            return (
              <ComponentSection
                key={type}
                nodePath={selectedPath}
                componentType={type}
                data={data}
                overriddenFields={overriddenFields}
                consumedOnly={consumedOnly}
                signalValue={headerValue}
                headerAction={type === 'AASLink' ? <AasDetailHeaderAction data={data} /> : undefined}
                onFieldEdit={(fieldName, value) => handleFieldEdit(type, fieldName, value)}
                onFieldReset={(fieldName) => handleFieldReset(type, fieldName)}
                onResetComponent={() => handleComponentReset(type)}
                viewer={viewer}
                signalStore={signalStore}
              />
            );
          })}
        </Box>
      )}

      {/* Footer inside scroll area for detached mode */}
      {detached && footerContent}
    </Box>
  );

  // ── Detached: floating ChartPanel ─────────────────────────────────────
  if (detached) {
    return (
      <ChartPanel
        open
        onClose={handleClose}
        title={nodeName}
        titleColor="#90caf9"
        subtitle={selectedPath}
        defaultWidth={420}
        defaultHeight={500}
        zIndex={1600}
        toolbar={toolbarButtons}
      >
        {scrollContent}
      </ChartPanel>
    );
  }

  // ── Pinned: docked LeftPanel ──────────────────────────────────────────
  return (
    <LeftPanel
      title={
        <Box sx={{ overflow: 'hidden' }}>
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {nodeName}
          </Typography>
          <Typography sx={{ fontSize: 9, color: 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedPath}
          </Typography>
        </Box>
      }
      onClose={handleClose}
      width={INSPECTOR_PANEL_WIDTH}
      leftOffset={state.panelWidth + 16}
      toolbar={toolbarButtons}
      footer={footerContent}
    >
      {scrollContent}
    </LeftPanel>
  );
}

// ── Reverse-direction helpers ──────────────────────────────────────────
// Bridge between the inspector UI and the LayoutPlannerPlugin's
// `reversePlacement` action. Kept here (instead of as plugin imports)
// because the inspector is plugin-agnostic.

function _canReversePlacement(viewer: RVViewer, nodePath: string): boolean {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return false;
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const placed = planner?.findPlacedAncestor(node);
  if (!placed) return false;
  // Has at least one paired snap?
  const snapReg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
  if (!snapReg) return false;
  for (const sp of snapReg.getAll()) {
    if (sp.ownerRoot === placed.root && sp.pairedSnapId) return true;
  }
  return false;
}

function _doReversePlacement(viewer: RVViewer, nodePath: string): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const placed = planner?.findPlacedAncestor(node);
  if (!placed) return;
  planner!.reversePlacement(placed.id);
}
