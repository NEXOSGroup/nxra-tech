// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Hierarchy row components.
 *
 * - `TreeNodeRow` — recursive tree row used by the "All" view
 * - `FlatNodeRow` — single-row component used by the virtualized type-filtered view
 *
 * Both are memoized so re-renders are limited to rows whose props have actually
 * changed. The parent `HierarchyBrowser` is responsible for keeping callbacks
 * stable via `useCallback` and the `selectedPaths` Set instance stable via
 * `useMemo`.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5).
 */

import { useCallback, memo } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ExpandMore, ChevronRight } from '@mui/icons-material';
import type { EditableNodeInfo } from './rv-extras-editor';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine } from '../engine/rv-logic-engine';
import { getStepInfoForPath, isLogicStepType, isSignalType, signalOwnerLabel, type TreeNode } from './hierarchy-utils';
import { NodeBadges, StepStateDot } from './hierarchy-badge-components';
import { useLongPress } from '../../hooks/use-long-press';

// ─── TreeNodeRow ─────────────────────────────────────────────────────────

export interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  onSelect: (path: string, shiftKey?: boolean) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Incrementing tick to bust memo cache for live step/signal updates. */
  liveTick: number;
}

export const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  selectedPaths,
  expanded,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onHover,
  onContextMenu,
  signalStore,
  logicEngine,
  liveTick,
}: TreeNodeRowProps) {
  const expandKey = node.path ?? node.name;
  const isExpanded = expanded.has(expandKey);
  const hasChildren = node.children.length > 0 || node.canExpandLazy === true;
  const hasComponents = node.types.length > 0;
  // Mesh-only children get a path but no component types; the caret icon
  // handles expand/collapse via stopPropagation so row clicks still select.
  const isSelectable = !!node.path;
  const isMeshOnly = isSelectable && !hasComponents;
  const isSelected = isSelectable && selectedPaths.has(node.path!);

  // Check if this node has a LogicStep component
  const hasLogicStep = node.types.some(isLogicStepType);
  const stepInfo = hasLogicStep ? getStepInfoForPath(logicEngine, node.path) : null;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isSelectable && node.path) {
      onSelect(node.path, e.shiftKey);
    } else {
      onToggleExpand(expandKey);
    }
  }, [isSelectable, node.path, onSelect, onToggleExpand, expandKey]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.path) onDoubleClick(node.path);
  }, [node.path, onDoubleClick]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(expandKey);
  }, [onToggleExpand, expandKey]);

  const handleMouseEnter = useCallback(() => {
    if (node.path) onHover(node.path);
  }, [node.path, onHover]);

  const handleMouseLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (node.path && onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node.path);
    }
  }, [node.path, onContextMenu]);

  // Long-press for touch context menu
  const handleLongPress = useCallback((x: number, y: number) => {
    if (node.path && onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        node.path,
      );
    }
  }, [node.path, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!(node.path && onContextMenu),
    onLongPress: handleLongPress,
  });

  return (
    <>
      <Box
        data-path={node.path ?? undefined}
        data-selectable={isSelectable || undefined}
        data-mesh-only={isMeshOnly || undefined}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerLeave={longPress.onPointerLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        sx={{
          display: 'flex',
          alignItems: 'center',
          pl: depth * 1 + 0.5,
          pr: 2,
          py: 0,
          cursor: 'pointer',
          userSelect: 'none',
          borderRadius: 0.5,
          minWidth: 0,
          bgcolor: isSelected ? 'rgba(79, 195, 247, 0.15)' : 'transparent',
          '&:hover': {
            bgcolor: isSelected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.04)',
          },
          minHeight: 20,
        }}
      >
        {hasChildren ? (
          <IconButton size="small" onClick={handleExpandClick} sx={{ p: 0, mr: 0.25, color: 'text.secondary' }}>
            {isExpanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
          </IconButton>
        ) : (
          <Box sx={{ width: 16, flexShrink: 0 }} />
        )}

        {/* Status dot for LogicStep nodes */}
        {stepInfo && <StepStateDot stepState={stepInfo.state} />}

        <Tooltip title={node.name} placement="top" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
          <Typography
            sx={{
              fontSize: 12,
              lineHeight: 1.3,
              fontWeight: hasComponents ? 400 : 500,
              color: isSelected
                ? 'primary.main'
                : isMeshOnly
                  ? 'text.disabled'
                  : hasComponents
                    ? 'text.primary'
                    : 'text.secondary',
              fontStyle: isMeshOnly ? 'italic' : 'normal',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 60,
              mr: 0.25,
            }}
          >
            {node.name}
          </Typography>
        </Tooltip>

        {hasComponents && (
          <NodeBadges types={node.types} signalStore={signalStore} path={node.path} stepInfo={stepInfo} />
        )}

      </Box>

      {hasChildren && isExpanded && node.children.map((child, i) => (
        <TreeNodeRow
          key={child.name + '-' + i}
          node={child}
          depth={depth + 1}
          selectedPaths={selectedPaths}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          onHover={onHover}
          onContextMenu={onContextMenu}
          signalStore={signalStore}
          logicEngine={logicEngine}
          liveTick={liveTick}
        />
      ))}
    </>
  );
});

// ─── FlatNodeRow (virtualized type-filtered view) ────────────────────────

export const FLAT_ROW_HEIGHT = 20;

export interface FlatNodeRowProps {
  info: EditableNodeInfo;
  selectedPaths: Set<string>;
  onSelect: (path: string, shiftKey?: boolean) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Relative indentation depth (0 = top-level in filtered view). */
  depth?: number;
  /** Absolute positioning style from virtualizer (when virtualized). */
  virtualStyle?: React.CSSProperties;
}

export const FlatNodeRow = memo(function FlatNodeRow({
  info,
  selectedPaths,
  onSelect,
  onDoubleClick,
  onHover,
  onContextMenu,
  signalStore,
  logicEngine,
  depth = 0,
  virtualStyle,
}: FlatNodeRowProps) {
  const leaf = info.path.split('/').pop() ?? info.path;
  // Signal nodes in the flat list get an owner-qualified dot-symbol label so the
  // same leaf on different instances ("Flow.Occupied") is distinguishable; the
  // full node path stays in the tooltip. Non-signal rows keep the bare leaf.
  const isSignal = info.types.some(isSignalType);
  const name = isSignal ? signalOwnerLabel(info.path) : leaf;
  const tooltipTitle = isSignal ? info.path : leaf;
  const isSelected = selectedPaths.has(info.path);

  const hasLogicStep = info.types.some(isLogicStepType);
  const stepInfo = hasLogicStep ? getStepInfoForPath(logicEngine, info.path) : null;
  const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(info.path, e.shiftKey);
  }, [info.path, onSelect]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick(info.path);
  }, [info.path, onDoubleClick]);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, info.path);
    }
  }, [info.path, onContextMenu]);

  const handleMouseEnter = useCallback(() => onHover(info.path), [info.path, onHover]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  const handleLongPress = useCallback((x: number, y: number) => {
    if (onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        info.path,
      );
    }
  }, [info.path, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!onContextMenu,
    onLongPress: handleLongPress,
  });

  return (
    <Box
      data-path={info.path}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      onContextMenu={handleCtxMenu}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerLeave={longPress.onPointerLeave}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={virtualStyle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        pl: depth > 0 ? 1 : 0.5,
        pr: 2,
        py: 0,
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: 0.5,
        bgcolor: isSelected ? 'rgba(79, 195, 247, 0.15)' : isContainer ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
        '&:hover': {
          bgcolor: isSelected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.06)',
        },
        height: FLAT_ROW_HEIGHT,
        minWidth: 0,
        // Container rows get top margin for visual group separation
        ...(isContainer && { mt: '4px' }),
        // Left border line for indented children (more prominent)
        ...(depth > 0 && {
          borderLeft: '2px solid rgba(79, 195, 247, 0.25)',
          ml: `${(depth - 1) * 14 + 8}px`,
        }),
      }}
    >
      {/* Status dot for LogicStep nodes — only Active/Waiting */}
      {stepInfo && <StepStateDot stepState={stepInfo.state} />}

      <Tooltip title={tooltipTitle} placement="top" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
        <Typography
          sx={{
            fontSize: 12,
            lineHeight: 1.3,
            color: isSelected ? 'primary.main' : 'text.primary',
            fontWeight: isContainer ? 600 : 400,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 60,
            mr: 0.5,
          }}
        >
          {name}
        </Typography>
      </Tooltip>

      <NodeBadges types={info.types} signalStore={signalStore} path={info.path} stepInfo={stepInfo} />
    </Box>
  );
});
