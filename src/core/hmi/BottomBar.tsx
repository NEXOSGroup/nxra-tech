// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  TextField, InputAdornment, Box, Paper, IconButton,
  Popover, Switch, FormControlLabel, Typography, Divider,
  List, ListItemButton, Tooltip,
} from '@mui/material';
import { Search, Clear, MoreHoriz, CenterFocusStrong } from '@mui/icons-material';
import { GroupsOverlay } from './GroupsOverlay';
import { useNodeFilter } from '../../hooks/use-node-filter';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useViewer } from '../../hooks/use-viewer';
import { componentColor } from './rv-inspector-helpers';
import { getCapabilities } from '../engine/rv-component-registry';
import { tooltipStore } from './tooltip/tooltip-store';
import { tooltipRegistry } from './tooltip/tooltip-registry';
import type { TooltipData } from './tooltip/tooltip-store';
import {
  loadSearchSettings, saveSearchSettings,
  getFilterSubscribers, type SearchSettings,
} from './search-settings-store';
import type { NodeSearchResult } from '../engine/rv-node-registry';
import { RvExtrasEditorPlugin } from './rv-extras-editor';
export { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { RV_SCROLL_CLASS } from './shared-sx';

const DEBOUNCE_MS = 250;

export function BottomBar() {
  const viewer = useViewer();
  const { filter, filteredNodes, tooMany, setFilter } = useNodeFilter();
  const MAX_DROPDOWN = 20;
  const displayedNodes = tooMany ? filteredNodes.slice(0, MAX_DROPDOWN) : filteredNodes;
  const [inputValue, setInputValue] = useState('');
  const [settings, setSettings] = useState<SearchSettings>(loadSearchSettings);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useMobileLayout();
  // Hide the mobile search FAB while the planner library strip is open — it docks
  // bottom-right and would overlap the strip / its thumbnails.
  const lpm = viewer.leftPanelManager;
  const lpmSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const libraryOpen = isMobile && lpmSnap.right.activePanel === 'layout-planner';
  // Center the search bar over the actual 3D view (between the docked windows),
  // not the whole window, so it tracks the viewport as panels open/resize.
  const insets = useViewportInsets();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [dropdownVisible, setDropdownVisible] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);
  const programmaticScroll = useRef(false);

  // Re-render when model loads (so groups icon appears)
  const [, setModelTick] = useState(0);
  useEffect(() => {
    const handler = () => setModelTick(t => t + 1);
    viewer.on('model-loaded', handler);
    return () => { viewer.off('model-loaded', handler); };
  }, [viewer]);

  // Settings popover anchor
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const settingsOpen = Boolean(settingsAnchor);

  // ─── Collapsible search bar (desktop) ───────────────────────────
  // The bar shows only a magnifier by default and expands to the full
  // search field on click/hover, collapsing again once the mouse leaves
  // (unless it still has focus, text, or the settings popover is open).
  const [searchExpanded, setSearchExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const barExpanded = isMobile || searchExpanded;

  const expandSearch = useCallback((focusInput: boolean) => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    setSearchExpanded(true);
    if (focusInput) setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const scheduleCollapse = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      const hasFocus = !!inputRef.current && document.activeElement === inputRef.current;
      if (hasFocus || inputValueRef.current || settingsOpenRef.current) return;
      setSearchExpanded(false);
    }, 200);
  }, []);

  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  // Debounced filter
  const applyFilter = useCallback(
    (val: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setFilter(val), DEBOUNCE_MS);
    },
    [setFilter],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setSelectedIdx(-1);
      setDropdownVisible(true);
      applyFilter(val);
    },
    [applyFilter],
  );

  const handleClear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setInputValue('');
    setFilter('');
    setMobileSearchOpen(false);
    setSettingsAnchor(null);
  }, [setFilter]);

  // Enter → focus camera on highlighted nodes (use first MAX_DROPDOWN when many)
  const handleFocus = useCallback(() => {
    if (filteredNodes.length > 0) {
      const subset = tooMany ? filteredNodes.slice(0, MAX_DROPDOWN) : filteredNodes;
      const nodes = subset.map(r => r.node);
      viewer.fitToNodes(nodes);
    }
  }, [viewer, filteredNodes, tooMany]);

  // Hover search result → show component tooltips at the 3D object's position
  const searchHoverIds = useRef<string[]>([]);
  const handleResultHover = useCallback(
    (result: NodeSearchResult | null) => {
      // Clear previous hover tooltips and highlight
      for (const id of searchHoverIds.current) tooltipStore.hide(id);
      searchHoverIds.current = [];
      if (!result) { viewer.highlighter.clear(); return; }

      const node = viewer.registry?.getNode(result.path);
      if (!node) return;
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;

      // Highlight the node in 3D
      viewer.highlighter.highlight(node, true);

      for (const key of Object.keys(rv)) {
        if (typeof rv[key] !== 'object') continue;
        const caps = getCapabilities(key);
        if (!caps.tooltipType) continue;
        const resolver = tooltipRegistry.getDataResolver(caps.tooltipType);
        if (!resolver) continue;
        const data = resolver(node, viewer);
        if (!data) continue;

        const hoverId = `search-hover:${caps.tooltipType}`;
        searchHoverIds.current.push(hoverId);
        tooltipStore.show({
          id: hoverId,
          lifecycle: 'hover',
          targetPath: result.path,
          data: data as TooltipData,
          mode: 'world',
          worldTarget: node,
          priority: caps.hoverPriority ?? 5,
        });
      }
    },
    [viewer],
  );

  // Click/select result → focus by path, select in hierarchy, hide dropdown
  const handleResultClick = useCallback(
    (result: NodeSearchResult) => {
      // Select the node (triggers pinned tooltips via GenericTooltipController)
      viewer.selectionManager.select(result.path);
      // Focus camera on the result (viewer auto-applies panel offset)
      viewer.focusByPath(result.path);
      // Select and reveal in hierarchy (opens panel if needed, expands ancestors, scrolls)
      const editorPlugin = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
      if (editorPlugin) editorPlugin.selectAndReveal(result.path);
      // Hide dropdown (keep search text)
      setDropdownVisible(false);
      setSelectedIdx(-1);
    },
    [viewer],
  );

  const visibleCount = displayedNodes.length;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClear();
        setSelectedIdx(-1);
        (e.target as HTMLElement).blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(prev => {
          const next = Math.min(prev + 1, visibleCount - 1);
          programmaticScroll.current = true;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(prev => {
          const next = Math.max(prev - 1, 0);
          programmaticScroll.current = true;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter') {
        if (selectedIdx >= 0 && selectedIdx < displayedNodes.length) {
          handleResultClick(displayedNodes[selectedIdx]);
        } else {
          handleFocus();
          setDropdownVisible(false);
          setSelectedIdx(-1);
        }
      }
    },
    [handleClear, handleFocus, handleResultClick, displayedNodes, selectedIdx, visibleCount],
  );

  // Cleanup debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // ─── Settings handlers ──────────────────────────────────────────

  const updateSettings = useCallback((patch: Partial<SearchSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSearchSettings(next);
      return next;
    });
  }, []);

  // Re-trigger filter when settings change (highlight or type toggles)
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (filter) setFilter(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.highlightEnabled, settings.nodesEnabled, settings.disabledTypes.join(',')]);

  const toggleType = useCallback((typeId: string) => {
    setSettings(prev => {
      const disabled = prev.disabledTypes.includes(typeId)
        ? prev.disabledTypes.filter(t => t !== typeId)
        : [...prev.disabledTypes, typeId];
      const next = { ...prev, disabledTypes: disabled };
      saveSearchSettings(next);
      return next;
    });
  }, []);

  const subscribers = getFilterSubscribers();
  const showResults = filter && filteredNodes.length > 0 && dropdownVisible;
  const resultCount = filteredNodes.length;

  // Count badge text
  const badgeText = filter ? `${resultCount} found` : null;

  return (
    <>
    {/* Mobile: search toggle FAB (hidden while the library strip is open) */}
    {isMobile && !libraryOpen && (
      <IconButton
        onClick={() => mobileSearchOpen ? handleClear() : setMobileSearchOpen(true)}
        sx={{
          position: 'fixed',
          bottom: 'calc(60px + env(safe-area-inset-bottom, 0px))',
          right: 12,
          zIndex: 1201,
          bgcolor: 'background.paper',
          boxShadow: 4,
          width: 40,
          height: 40,
          pointerEvents: 'auto',
        }}
      >
        {mobileSearchOpen ? <Clear /> : <Search />}
      </IconButton>
    )}
    <Box
      sx={{
        position: 'fixed',
        bottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom, 0px))' : 8,
        left: insets.left,
        right: insets.right,
        zIndex: 1200,
        pointerEvents: 'none',
        ...(isMobile && {
          transform: mobileSearchOpen ? 'translateY(0)' : 'translateY(calc(100% + 80px))',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }),
      }}
    >
      {/* Centered search bar + results */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* Result dropdown (above search bar) */}
        {showResults && (
          <Paper
            elevation={4}
            className={RV_SCROLL_CLASS}
            onScroll={() => { if (programmaticScroll.current) programmaticScroll.current = false; else if (selectedIdx >= 0) setSelectedIdx(-1); }}
            sx={{
              width: { xs: 'calc(100vw - 24px)', sm: 388 },
              mb: 0.5,
              borderRadius: 2,
              pointerEvents: 'auto',
            }}
          >
            <List dense disablePadding ref={listRef}>
              {displayedNodes.map((r, i) => {
                const nodeName = r.path.split('/').pop() ?? r.path;
                const label = r.displayText ?? nodeName;
                // Show where the match was found: matchedBy component, or primary type for name matches
                const badgeType = r.matchedBy ?? (r.types.length > 0 ? r.types[0] : 'Node');
                const isSelected = i === selectedIdx;
                return (
                  <Tooltip title={r.path} placement="right" enterDelay={800} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
                  <ListItemButton
                    key={r.path}
                    selected={isSelected}
                    onClick={() => { handleResultHover(null); handleResultClick(r); }}
                    onMouseEnter={() => { setSelectedIdx(i); handleResultHover(r); }}
                    onMouseMove={() => { if (selectedIdx !== i) { setSelectedIdx(i); handleResultHover(r); } }}
                    onMouseLeave={() => handleResultHover(null)}
                    sx={{ py: 0.25, px: 1.5, minHeight: 0 }}
                  >
                    <Typography variant="body2" noWrap sx={{ flex: 1 }}>{label}</Typography>
                    {badgeType && (
                      <Typography variant="caption" noWrap sx={{
                        ml: 0.5, fontSize: '0.6rem', fontWeight: 600,
                        color: componentColor(badgeType), opacity: 0.8,
                      }}>
                        {badgeType}
                      </Typography>
                    )}
                  </ListItemButton>
                  </Tooltip>
                );
              })}
              {resultCount > MAX_DROPDOWN && (
                <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', py: 0.5, color: 'text.disabled' }}>
                  and {resultCount - MAX_DROPDOWN} more — type to narrow
                </Typography>
              )}
            </List>
          </Paper>
        )}

        {/* Search bar — collapses to a magnifier on desktop, expands on click/hover */}
        <Paper
          elevation={4}
          data-ui-panel
          onMouseEnter={isMobile ? undefined : () => expandSearch(false)}
          onMouseLeave={isMobile ? undefined : scheduleCollapse}
          sx={{
            py: 0,
            pl: 0,
            pr: barExpanded ? 1.5 : 0,
            borderRadius: 2,
            pointerEvents: 'auto',
            width: barExpanded ? { xs: 'calc(100vw - 24px)', sm: 380 } : 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1), padding 0.25s',
          }}
        >
          {/* Magnifier — always visible; click to open + focus */}
          <IconButton
            size="small"
            aria-label="Search"
            onClick={() => expandSearch(true)}
            sx={{ width: 40, height: 40, flexShrink: 0, color: filter ? 'primary.main' : 'text.secondary' }}
          >
            <Search fontSize="small" />
          </IconButton>

          {/* Collapsible content */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              flex: 1,
              minWidth: 0,
              opacity: barExpanded ? 1 : 0,
              pointerEvents: barExpanded ? 'auto' : 'none',
              transition: 'opacity 0.2s',
            }}
          >
            <TextField
              placeholder="Search drives, sensors, objects..."
              size="small"
              fullWidth
              variant="standard"
              value={inputValue}
              inputRef={inputRef}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => expandSearch(false)}
              onBlur={isMobile ? undefined : scheduleCollapse}
              slotProps={{
                input: {
                  disableUnderline: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      {badgeText && (
                        <Typography variant="caption" sx={{ color: 'primary.main', mr: 0.5, whiteSpace: 'nowrap' }}>
                          {badgeText}
                        </Typography>
                      )}
                      {/* Focus button (touch alternative to Enter) */}
                      {filter && filteredNodes.length > 0 && (
                        <IconButton size="small" onClick={handleFocus} sx={{ p: 0.25 }} title="Focus camera (Enter)">
                          <CenterFocusStrong sx={{ fontSize: 16, color: 'primary.main' }} />
                        </IconButton>
                      )}
                      {filter && (
                        <IconButton size="small" onClick={handleClear} sx={{ p: 0.25 }}>
                          <Clear sx={{ fontSize: 16, color: 'text.secondary' }} />
                        </IconButton>
                      )}
                    </InputAdornment>
                  ),
                },
              }}
            />
            <IconButton
              size="small"
              onClick={(e) => setSettingsAnchor(e.currentTarget)}
              sx={{ ml: 0.5, p: 0.25 }}
            >
              <MoreHoriz sx={{ fontSize: 18, color: 'text.secondary' }} />
            </IconButton>
          </Box>
        </Paper>
      </Box>

      {/* Camera / view controls now live in the full-width top app bar
          (TopBar.tsx right region). The Groups overlay panel itself still
          renders here. */}
      <GroupsOverlay />

      {/* Search settings popover */}
      <Popover
        open={settingsOpen}
        anchorEl={settingsAnchor}
        onClose={() => { setSettingsAnchor(null); if (!isMobile) scheduleCollapse(); }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slotProps={{ paper: { sx: { p: 2, minWidth: 220, pointerEvents: 'auto' } } }}
      >
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Search Settings</Typography>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={settings.highlightEnabled}
              onChange={(_, checked) => updateSettings({ highlightEnabled: checked })}
            />
          }
          label={<Typography variant="body2">Highlight in 3D</Typography>}
          sx={{ ml: 0 }}
        />
        <Divider sx={{ my: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
          Include:
        </Typography>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={settings.nodesEnabled}
              onChange={(_, checked) => updateSettings({ nodesEnabled: checked })}
            />
          }
          label={<Typography variant="body2">All Objects</Typography>}
          sx={{ ml: 0, display: 'flex' }}
        />
        {subscribers.map((sub) => (
          <FormControlLabel
            key={sub.id}
            control={
              <Switch
                size="small"
                checked={!settings.disabledTypes.includes(sub.id)}
                onChange={() => toggleType(sub.id)}
              />
            }
            label={<Typography variant="body2">{sub.label}</Typography>}
            sx={{ ml: 0, display: 'flex' }}
          />
        ))}
      </Popover>
    </Box>
    </>
  );
}
