// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * HierarchyBrowser — Tree view of all GLB nodes with rv extras.
 *
 * Features:
 * - Search filter (case-insensitive path substring)
 * - Type filter buttons (All, Drives, Sensors, Signals, Logic)
 * - Component type badges with live signal values
 * - LogicStep status dots with ISA-101 colors and pulse animation
 * - Container progress counters
 * - Click to select (updates plugin state)
 * - Resizable width (drag right edge)
 * - Node count footer
 * - Reveal-and-scroll: external code can call plugin.selectAndReveal(path)
 *   to expand ancestor tree nodes and scroll the selected node into view
 *
 * Composition (plan-177 Phase 5):
 * - Tree/badge utilities live in `hierarchy-utils.ts`
 * - Row components live in `HierarchyNodeRow.tsx`
 * - Badge primitives live in `hierarchy-badge-components.tsx`
 * - Signals sort toolbar lives in `SignalBrowser.tsx`
 * - Long-press logic is the shared `useLongPress` hook
 */

import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useSelection } from '../../hooks/use-selection';
import { useSignalTick } from '../../hooks/use-signal-tick';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Chip,
} from '@mui/material';
import { Search } from '@mui/icons-material';
import { filterChipSx, RV_SCROLL_CLASS } from './shared-sx';
import type { RVViewer } from '../rv-viewer';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import type { ContextMenuTarget } from './context-menu-store';
import { HIERARCHY_MIN_WIDTH, HIERARCHY_MAX_WIDTH } from './rv-extras-editor';
import { LeftPanel } from './LeftPanel';
import { getSceneStore } from './scene/scene-store-singleton';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  buildTree,
  computeAncestors,
  countNodes,
  filterTree,
  matchesTypeFilter,
  sortSignalNodes,
  type SignalSort,
  type TypeFilter,
} from './hierarchy-utils';
import { FLAT_ROW_HEIGHT, FlatNodeRow, TreeNodeRow } from './HierarchyNodeRow';
import { SignalBrowser } from './SignalBrowser';

// Re-exports for backwards compatibility — external callers (and tests) may
// import these symbols from `rv-hierarchy-browser`.
export { computeAncestors } from './hierarchy-utils';
export type { TreeNode, TypeFilter, SignalSort } from './hierarchy-utils';

// ─── CSS pulse animation ─────────────────────────────────────────────────

const PULSE_STYLE_ID = 'rv-pulse-keyframes';

function ensurePulseAnimation(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes rv-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.4; transform: scale(0.75); }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes rv-pulse {
        0%, 100% { opacity: 0.7; }
      }
    }
  `;
  document.head.appendChild(style);
}

// ─── Type filter chips ───────────────────────────────────────────────────

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'drives', label: 'Drives' },
  { key: 'sensors', label: 'Sensors' },
  { key: 'signals', label: 'Signals' },
  { key: 'logic', label: 'Logic' },
];

// ─── Hierarchy expand-state persistence ──────────────────────────────────

const LS_KEY_TREE_EXPANDED = 'rv-hierarchy-expanded';

function loadTreeExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_TREE_EXPANDED);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

/** Debounce timer for batching LS writes of expanded state. */
let expandPersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistTreeExpandedSet(expanded: Set<string>): void {
  if (expandPersistTimer) clearTimeout(expandPersistTimer);
  expandPersistTimer = setTimeout(() => {
    localStorage.setItem(LS_KEY_TREE_EXPANDED, JSON.stringify([...expanded]));
  }, 300);
}

// ─── Main component ──────────────────────────────────────────────────────

export interface HierarchyBrowserProps {
  viewer: RVViewer;
}

export function HierarchyBrowser({ viewer }: HierarchyBrowserProps) {
  const { plugin, state } = useEditorPlugin();
  const selection = useSelection();

  // Read the active model name from SceneStore — used as the panel title so
  // the Hierarchy header mirrors the Models window's "current scene" framing.
  const sceneStore = getSceneStore();
  const sceneSnap = useSyncExternalStore(
    sceneStore?.subscribe ?? (() => () => {}),
    sceneStore?.getSnapshot ?? (() => null),
  );
  const modelName = sceneSnap?.draft?.name ?? 'Hierarchy';

  // Ensure pulse animation CSS is injected
  useEffect(() => { ensurePulseAnimation(); }, []);

  if (!plugin) return null;

  // Multi-select aware: Set for O(1) lookups in row components
  const selectedPathsSet = useMemo(
    () => new Set(selection.selectedPaths),
    [selection.selectedPaths],
  );

  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilterRaw] = useState<TypeFilter>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-type-filter'); return (v as TypeFilter) ?? 'all'; } catch { return 'all'; }
  });
  const setTypeFilter = useCallback((v: TypeFilter) => {
    setTypeFilterRaw(v);
    try { localStorage.setItem('rv-hierarchy-type-filter', v); } catch { /* */ }
  }, []);
  const [signalSort, setSignalSortRaw] = useState<SignalSort>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-signal-sort'); return (v as SignalSort) ?? 'name'; } catch { return 'name'; }
  });
  const setSignalSort = useCallback((v: SignalSort) => {
    setSignalSortRaw(v);
    try { localStorage.setItem('rv-hierarchy-signal-sort', v); } catch { /* */ }
  }, []);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const signalStore = viewer.signalStore;
  const logicEngine = viewer.logicEngine;

  // Consolidated live data polling at 200ms (for both signals and step states)
  const liveTick = useSignalTick(signalStore, 200);

  // ── Lifted expand state (shared across all TreeNodeRows) ──
  const [expanded, setExpanded] = useState<Set<string>>(() => loadTreeExpanded());

  const onToggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistTreeExpandedSet(next);
      return next;
    });
  }, []);

  // Flat list when type filter is active OR search is active (bypasses tree hierarchy)
  const flatFiltered = useMemo(() => {
    if (typeFilter === 'all' && !searchTerm) return null;
    let nodes = typeFilter !== 'all'
      ? state.editableNodes.filter(n => matchesTypeFilter(n.types, typeFilter))
      : state.editableNodes;
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      nodes = nodes.filter(n => {
        const leafName = n.path.split('/').pop() ?? n.path;
        return leafName.toLowerCase().includes(lower);
      });
    }
    if (typeFilter === 'signals') {
      nodes = sortSignalNodes(nodes, signalSort);
    }
    return nodes;
  }, [state.editableNodes, typeFilter, searchTerm, signalSort]);

  // Compute relative depth for flat filtered nodes (for indentation in Logic view)
  const flatDepths = useMemo(() => {
    if (!flatFiltered || flatFiltered.length === 0) return new Map<string, number>();
    const depths = new Map<string, number>();
    const minSegments = Math.min(...flatFiltered.map(n => n.path.split('/').length));
    for (const n of flatFiltered) {
      depths.set(n.path, n.path.split('/').length - minSegments);
    }
    return depths;
  }, [flatFiltered]);

  // Flat list virtualizer (only active when typeFilter !== 'all')
  // Container rows have 4px top margin, so estimate slightly larger
  const flatRowVirtualizer = useVirtualizer({
    count: flatFiltered?.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!flatFiltered) return FLAT_ROW_HEIGHT;
      const info = flatFiltered[index];
      const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');
      return isContainer ? FLAT_ROW_HEIGHT + 4 : FLAT_ROW_HEIGHT;
    },
    overscan: 10,
  });

  // Ref to access virtualizer without adding it to effect deps (new object every render)
  const flatVirtualizerRef = useRef(flatRowVirtualizer);
  flatVirtualizerRef.current = flatRowVirtualizer;

  // ── Consume revealPath: expand ancestors and scroll to selected ──
  useEffect(() => {
    const revealPath = state.revealPath;
    if (!revealPath) return;

    // Expand all ancestor tree nodes
    const ancestors = computeAncestors(revealPath);
    if (ancestors.length > 0) {
      setExpanded(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const a of ancestors) {
          if (!next.has(a)) { next.add(a); changed = true; }
        }
        if (changed) persistTreeExpandedSet(next);
        return changed ? next : prev;
      });
    }

    // Clear the reveal request after consuming
    plugin.clearReveal();

    // Scroll the selected node into view
    // Flat mode: use virtualizer scrollToIndex; Tree mode: use DOM scrollIntoView
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (flatFiltered) {
          // Flat virtualized list — find index and scroll via virtualizer
          const idx = flatFiltered.findIndex(n => n.path === revealPath);
          if (idx >= 0) flatVirtualizerRef.current.scrollToIndex(idx, { align: 'auto' });
        } else {
          // Tree mode — use DOM query
          const container = scrollContainerRef.current;
          if (!container) return;
          const el = container.querySelector(`[data-path="${CSS.escape(revealPath)}"]`);
          if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, 150);
    });
  }, [state.revealPath, plugin, flatFiltered]);

  // Tree view (only when typeFilter === 'all').
  // viewer + expanded together let buildTree lazily inject Three.js
  // children of expanded LayoutObject nodes.
  const tree = useMemo(
    () => typeFilter === 'all' ? buildTree(state.editableNodes, state.overlay, viewer, expanded) : [],
    [state.editableNodes, state.overlay, typeFilter, viewer, expanded],
  );

  const filteredTree = useMemo(
    () => typeFilter === 'all' ? filterTree(tree, searchTerm, viewer) : [],
    [tree, searchTerm, typeFilter, viewer],
  );

  const counts = useMemo(
    () => countNodes(state.editableNodes, state.overlay),
    [state.editableNodes, state.overlay],
  );

  const displayCount = flatFiltered !== null ? flatFiltered.length : counts.total;

  // ── Hover highlight (orange, temporary) ──
  // Selection highlight (cyan, persistent) is handled by SelectionManager.
  // Debounced to avoid blocking the UI when scrolling over many hierarchy rows.

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Snap 3D-highlight (A5) ──
  // A snap Empty has no mesh, so the outline highlighter shows nothing. When a
  // hierarchy row is a snap node, drive the snap-point plugin's marker highlight
  // instead (hover = temporary, select = persistent). The snap id is the node's
  // Object3D.uuid (== SnapPoint.id).
  const snapIdForPath = useCallback((path: string | null): string | null => {
    if (!path) return null;
    const node = viewer.registry?.getNode(path);
    if (!node) return null;
    const reg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    return reg?.getById(node.uuid) ? node.uuid : null;
  }, [viewer]);

  const highlightSnap = useCallback((snapId: string | null) => {
    viewer.getPlugin<SnapPointPlugin>('snap-point')?.highlightSnap(snapId);
  }, [viewer]);

  const handleHover = useCallback((path: string | null) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (!path) { viewer.highlighter.clear(); highlightSnap(null); return; }
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const node = viewer.registry?.getNode(path);
      if (node) {
        viewer.highlighter.highlight(node, true, { includeChildDrives: true });
        // Snap node → also show the 3D marker highlight (temporary hover).
        highlightSnap(snapIdForPath(path));
      } else {
        viewer.highlighter.clear();
        highlightSnap(null);
      }
    }, 80);
  }, [viewer, highlightSnap, snapIdForPath]);

  const handleSelect = useCallback(
    (path: string, shiftKey = false) => {
      if (shiftKey) {
        viewer.selectionManager.toggleWithChildren(path);
      } else {
        viewer.selectionManager.select(path);
      }
      // Persistent snap highlight on select; clears when a non-snap is selected.
      highlightSnap(snapIdForPath(path));
      plugin.selectNode(path, true);
    },
    [viewer, plugin, highlightSnap, snapIdForPath],
  );

  const handleDoubleClick = useCallback(
    (path: string) => {
      if (!viewer.registry) return;
      const node = viewer.registry.getNode(path);
      if (node) {
        viewer.fitToNodes([node]); // viewer auto-applies panel offset
      }
    },
    [viewer],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (!viewer.registry) return;
      const node = viewer.registry.getNode(path);
      if (!node) return;
      const target: ContextMenuTarget = {
        path,
        node,
        types: viewer.registry.getComponentTypes(path),
        extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      };
      // Highlight the node and hold hover while context menu is open
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      viewer.highlighter.highlight(node, false, { includeChildDrives: isLayout });
      if (viewer.raycastManager) viewer.raycastManager.holdHover = true;
      viewer.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
    },
    [viewer],
  );

  // Clear hover + snap highlight when panel closes / unmounts
  useEffect(() => {
    return () => { viewer.highlighter.clear(); highlightSnap(null); };
  }, [viewer, highlightSnap]);

  const handleClose = useCallback(() => {
    viewer.highlighter.clear();
    highlightSnap(null);
    plugin.togglePanel();
  }, [plugin, viewer, highlightSnap]);

  const isFlat = flatFiltered !== null;

  return (
    <LeftPanel
      title={
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            fontSize: '0.8rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={modelName}
        >
          {modelName}
        </Typography>
      }
      onClose={handleClose}
      width={state.panelWidth}
      resizable
      minWidth={HIERARCHY_MIN_WIDTH}
      maxWidth={HIERARCHY_MAX_WIDTH}
      onResize={(w) => plugin.setPanelWidth(w)}
      headerSx={{ px: 1.5, py: 0.75 }}
      footer={
        <Box sx={{ px: 1, py: 0.25, display: 'flex', alignItems: 'center' }}>
          <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
            {isFlat
              ? `${displayCount} of ${counts.total} node${counts.total !== 1 ? 's' : ''}`
              : `${counts.total} node${counts.total !== 1 ? 's' : ''}`}
            {counts.withOverrides > 0 && (
              <> &middot; {counts.withOverrides} with override{counts.withOverrides !== 1 ? 's' : ''}</>
            )}
          </Typography>
        </Box>
      }
    >
      {/* Search */}
      <Box sx={{ px: 0.75, py: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search nodes..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && flatFiltered && flatFiltered.length > 0) {
              handleSelect(flatFiltered[0].path);
            }
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                </InputAdornment>
              ),
              sx: { fontSize: 12, height: 26 },
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: 'rgba(255, 255, 255, 0.04)',
              '& fieldset': { borderColor: 'rgba(255, 255, 255, 0.08)' },
              '&:hover fieldset': { borderColor: 'rgba(255, 255, 255, 0.15)' },
              '&.Mui-focused fieldset': { borderColor: 'primary.main' },
            },
          }}
        />
      </Box>

      {/* Type filter buttons */}
      <Box sx={{ display: 'flex', gap: 0.25, px: 0.75, py: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
        {TYPE_FILTERS.map(({ key, label }) => (
          <Chip
            key={key}
            label={label}
            size="small"
            onClick={() => setTypeFilter(key)}
            sx={filterChipSx(typeFilter === key)}
          />
        ))}
      </Box>

      {/* Signal sort buttons (only when Signals filter active) */}
      {typeFilter === 'signals' && (
        <SignalBrowser sort={signalSort} onSortChange={setSignalSort} />
      )}

      {/* Tree / Flat list — own scroll container for useVirtualizer compatibility */}
      <Box
        ref={scrollContainerRef}
        className={RV_SCROLL_CLASS}
        sx={{
          flex: 1,
          overflow: 'auto',
          py: 0.5,
        }}
      >
        {isFlat ? (
          // Virtualized flat list (type filter active — no tree hierarchy)
          flatFiltered.length > 0 ? (
            <div style={{ height: flatRowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {flatRowVirtualizer.getVirtualItems().map((virtualRow) => {
                const info = flatFiltered[virtualRow.index];
                return (
                  <FlatNodeRow
                    key={info.path}
                    info={info}
                    selectedPaths={selectedPathsSet}
                    onSelect={handleSelect}
                    onDoubleClick={handleDoubleClick}
                    onHover={handleHover}
                    onContextMenu={handleContextMenu}
                    signalStore={signalStore}
                    logicEngine={logicEngine}
                    depth={typeFilter === 'logic' ? (flatDepths.get(info.path) ?? 0) : 0}
                    virtualStyle={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  />
                );
              })}
            </div>
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              No matching nodes
            </Typography>
          )
        ) : (
          // Tree view (All filter)
          filteredTree.length > 0 ? (
            filteredTree.map((node, i) => (
              <TreeNodeRow
                key={node.name + '-' + i}
                node={node}
                depth={0}
                selectedPaths={selectedPathsSet}
                expanded={expanded}
                onToggleExpand={onToggleExpand}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
                onHover={handleHover}
                onContextMenu={handleContextMenu}
                signalStore={signalStore}
                logicEngine={logicEngine}
                liveTick={liveTick}
              />
            ))
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              {state.editableNodes.length === 0 ? 'No model loaded' : 'No matching nodes'}
            </Typography>
          )
        )}
      </Box>
    </LeftPanel>
  );
}
