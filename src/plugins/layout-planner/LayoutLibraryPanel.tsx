// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutLibraryPanel — Multi-tab library browser for the Layout Planner.
 *
 * Each library URL appears as its own tab. Users browse thumbnails by category,
 * drag components into the 3D scene, and manage grid/save/load settings.
 *
 * Relies on LayoutStore (useSyncExternalStore) for reactive state.
 */

import { useState, useCallback, useSyncExternalStore, memo, useRef, type ReactNode } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  TextField,
  Button,
  Tooltip,
  Switch,
  MenuItem,
  ListItemIcon,
  Divider,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tabs,
  Tab,
  Menu,
} from '@mui/material';
import {
  Add,
  CameraAlt,
  TimerOutlined,
  Cloud,
  GitHub,
  FolderOpen,
  Landscape,
  ErrorOutline,
  Close,
  ViewSidebar,
  KeyboardArrowUp,
  MoreVert,
  Check,
  Refresh,
  Delete,
  Link as LinkIcon,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useActiveContexts } from '../../core/hmi/ui-context-store';
import { LeftPanel, WINDOW_DARK_BG } from '../../core/hmi/LeftPanel';
import { RV_SCROLL_CLASS } from '../../core/hmi/shared-sx';
import { LAYOUT_PANEL_WIDTH, LEFT_PANEL_ZINDEX } from '../../core/hmi/layout-constants';
import { showInfoOverlay } from '../../core/hmi/info-overlay-store';
import type { LayoutPlannerPlugin } from './index';
import type { LibraryCatalogEntry, LayoutSnapshot } from './rv-layout-store';
import { LOCAL_NEEDS_PERMISSION, isGitHubRepoScanUrl } from './rv-layout-store';
import { setLayoutDragData, suppressDragImage } from './drag-types';
import { matchMaterialFlows } from '../../core/material-flow/registry';

/** Short, general behavior description for a library entry (hover tooltip). Resolves
 *  the entry to its behavior def by name (+ de-spaced variant + id), so e.g. "Chain
 *  Transfer Left" → ChainTransfer (model glob `*ChainTransfer*`). Null when none. */
function behaviorDescription(entry: LibraryCatalogEntry): string | null {
  for (const c of [entry.name, entry.name.replace(/\s+/g, ''), entry.id]) {
    const m = matchMaterialFlows(c);
    if (m.length && m[0].description) return m[0].description;
  }
  return null;
}
import { CatalogBrowser } from './CatalogBrowser';
import { LibrarySelector, type LibraryItem } from './LibrarySelector';
import { deriveChips, filterByChip } from './library-chips';


// ─── Constants ──────────────────────────────────────────────────────────

const PANEL_ID = 'layout-planner';

/** Width (px) of one thumbnail card inside the mobile horizontal strip. */
const MOBILE_CARD_WIDTH = 84;
/** Height (px) of the bottom nav strips (ActivityBar / ButtonPanel) the mobile
 *  strip/tab sits flush on top of — no gap below it. The bars add the safe-area
 *  inset as bottom padding, so the strip adds the same inset on top of this. */
const MOBILE_NAV_CLEARANCE = 48;

// ─── Panel Component ────────────────────────────────────────────────────

// Stable fallback for the cloud store's useSyncExternalStore snapshot. Must be
// a module-level constant: returning a fresh object literal from the getSnapshot
// fallback makes useSyncExternalStore see a new reference every render, which in
// public builds (no cloud extension) triggers an infinite re-render loop
// (React "Maximum update depth exceeded", minified error #185).
const EMPTY_CLOUD_SNAPSHOT = { connections: [], activeConnectionId: null };

export function LayoutLibraryPanel() {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  const activeContexts = useActiveContexts();
  const lpm = viewer.leftPanelManager;
  const lpmSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  // Planner docks to the right slot — read its state directly so it stays
  // independent of whatever (hierarchy / settings / ...) is open on the left.
  const isOpen = lpmSnapshot.right.activePanel === PANEL_ID;

  const plugin = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const store = plugin?.store;

  // Subscribe to store
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => null as unknown as LayoutSnapshot),
  );

  // Unity Asset Manager store (lives on the plugin for restore access)
  const cloudStore = plugin?.cloudStore ?? null;
  const cloudSnapshot = useSyncExternalStore(
    cloudStore?.subscribe ?? (() => () => {}),
    cloudStore?.getSnapshot ?? (() => EMPTY_CLOUD_SNAPSHOT),
  );

  // Active tab: either a catalog URL or "am:<connectionId>"
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Dialog states
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addDialogTab, setAddDialogTab] = useState(0); // 0 = URL, 1 = GitHub, 2 = Asset Manager
  const [ghUrl, setGhUrl] = useState('');
  const [amLabel, setAmLabel] = useState('');
  const [amProjId, setAmProjId] = useState('');
  const [amKeyId, setAmKeyId] = useState('');
  const [amSecret, setAmSecret] = useState('');
  const [searchText, setSearchText] = useState('');
  // Save / Load / Clear dialogs were removed when those actions migrated
  // to the unified Scene window — see footer note in this file's render.

  // Edit AM connection dialog
  const [editAmId, setEditAmId] = useState<string | null>(null);
  const [editAmLabel, setEditAmLabel] = useState('');
  const [editAmProjId, setEditAmProjId] = useState('');
  const [editAmKeyId, setEditAmKeyId] = useState('');
  const [editAmSecret, setEditAmSecret] = useState('');

  // Selected filter chip (null = "All"). Shared across every tab type:
  // collections when the catalog defines them, otherwise the category enum
  // (see `deriveChips` / `filterByChip`). Reset when switching tabs.
  const [selectedChip, setSelectedChip] = useState<string | null>(null);

  // Closing the library only HIDES the panel. The library is optional in planner
  // mode — the plugin's lpm subscription keeps edit bindings active while in
  // planner mode (and releases them only in the standalone, pre-mode path), so
  // we must NOT call setActive(false) here.
  const handleClose = useCallback(() => {
    lpm.close(PANEL_ID);
  }, [lpm]);

  // Make `id` the active library: update both the React tab state and (for
  // store-backed catalogs) the store's activeTabUrl so the grid, chips and
  // count all read the same catalog. Used by add + dropdown-select.
  const switchToLibrary = useCallback((id: string) => {
    setActiveTabId(id);
    setSelectedChip(null);
    if (!id.startsWith('am:')) store?.setActiveTab(id);
  }, [store]);

  const handleAddCatalog = useCallback(async () => {
    if (!store || !addUrl.trim()) return;
    const url = addUrl.trim();
    setAddLoading(true);
    await store.addCatalog(url);
    setAddLoading(false);
    setAddUrl('');
    setAddUrlOpen(false);
    switchToLibrary(url);
  }, [store, addUrl, switchToLibrary]);

  const handleAddGitHub = useCallback(async () => {
    if (!store || !ghUrl.trim()) return;
    const url = ghUrl.trim();
    setAddLoading(true);
    // store.addCatalog() auto-detects a GitHub repo/folder URL and scans it for
    // .glb files; a direct catalog.json URL (blob→raw) is also supported.
    await store.addCatalog(url);
    setAddLoading(false);
    setGhUrl('');
    setAddUrlOpen(false);
    switchToLibrary(url);
  }, [store, ghUrl, switchToLibrary]);

  const handleAddAssetManager = useCallback(() => {
    if (!cloudStore || !amProjId.trim() || !amKeyId.trim() || !amSecret.trim()) return;
    const label = amLabel.trim() || `Asset Manager (${amProjId.trim().slice(0, 8)}...)`;
    const id = cloudStore.addConnection(label, {
      projectId: amProjId.trim(),
      keyId: amKeyId.trim(),
      secretKey: amSecret.trim(),
    });
    // Reset form & switch to new connection tab
    setAmLabel(''); setAmProjId(''); setAmKeyId(''); setAmSecret('');
    setAddUrlOpen(false);
    setActiveTabId(`am:${id}`);
  }, [cloudStore, amLabel, amProjId, amKeyId, amSecret]);

  const handleAddLocalFolder = useCallback(async () => {
    if (!store) return;
    setAddLoading(true);
    await store.addLocalFolder();
    setAddLoading(false);
    setAddUrlOpen(false);
    // The local key depends on the chosen folder name, so resolve it from the
    // store after adding, then switch to it.
    const localUrl = store.getSnapshot().catalogUrls.find(u => u.startsWith('local:'));
    if (localUrl) switchToLibrary(localUrl);
  }, [store, switchToLibrary]);

  const handleRefreshLocalFolder = useCallback(async () => {
    if (!store) return;
    await store.refreshLocalFolder();
  }, [store]);

  const handleEditAmConnection = useCallback((connId: string) => {
    const cs = cloudSnapshot.connections.find(c => c.conn.id === connId);
    if (!cs) return;
    setEditAmId(connId);
    setEditAmLabel(cs.conn.label);
    setEditAmProjId(cs.conn.config.projectId);
    setEditAmKeyId(cs.conn.config.keyId);
    setEditAmSecret(cs.conn.config.secretKey);
  }, [cloudSnapshot]);

  const handleSaveAmEdit = useCallback(() => {
    if (!cloudStore || !editAmId || !editAmProjId.trim() || !editAmKeyId.trim() || !editAmSecret.trim()) return;
    const label = editAmLabel.trim() || `Asset Manager (${editAmProjId.trim().slice(0, 8)}...)`;
    cloudStore.updateConnection(editAmId, label, {
      projectId: editAmProjId.trim(),
      keyId: editAmKeyId.trim(),
      secretKey: editAmSecret.trim(),
    });
    setEditAmId(null);
  }, [cloudStore, editAmId, editAmLabel, editAmProjId, editAmKeyId, editAmSecret]);

  if (!plugin || !store || !snapshot) return null;

  // The panel itself:
  if (!isOpen) {
    // Compact layout: the library doesn't auto-open on phones, so while the
    // planner is active show a small bottom tab to reveal the horizontal strip.
    // Desktop (or planner inactive): render nothing.
    if (isMobile && activeContexts.has('planner')) {
      return <MobileLibraryTab onOpen={() => lpm.open(PANEL_ID, LAYOUT_PANEL_WIDTH, 'right')} />;
    }
    return null;
  }

  // Build unified tab list: [catalog URLs...] + [AM connections...]
  const visibleCatalogUrls = snapshot.catalogUrls.filter(u => u !== 'bundled://unity-cloud');
  const amConnections = cloudSnapshot.connections;

  // All tab IDs in order
  const allTabIds: string[] = [
    ...visibleCatalogUrls,
    ...amConnections.map(c => `am:${c.conn.id}`),
  ];

  // Resolve active tab
  const resolvedActiveTabId = activeTabId && allTabIds.includes(activeTabId)
    ? activeTabId
    : (snapshot.activeTabUrl && visibleCatalogUrls.includes(snapshot.activeTabUrl))
      ? snapshot.activeTabUrl
      : allTabIds[0] ?? null;
  const isAmTab = resolvedActiveTabId?.startsWith('am:') ?? false;
  const activeAmId = isAmTab ? resolvedActiveTabId!.slice(3) : null;
  const isLocalTab = resolvedActiveTabId?.startsWith('local:') ?? false;

  // Active (non-AM) catalog + the shared chip/filter pipeline. Every public
  // tab — remote URL, GitHub scan, Local Folder — now runs through the same
  // CatalogBrowser shell driven by these values.
  const activeError = resolvedActiveTabId ? snapshot.catalogErrors.get(resolvedActiveTabId) : null;
  const activeCatalog = !isAmTab && resolvedActiveTabId ? snapshot.catalogs.get(resolvedActiveTabId) : null;
  const fullEntries = activeCatalog?.entries ?? [];
  // Chips/counts use the UNFILTERED entries so totals stay stable while the
  // user types in the search field (matching the prior Local/Cloud UX).
  const chips = deriveChips(fullEntries);
  // Displayed grid: search filter then the selected chip. Both derive from
  // `fullEntries` (the resolved active catalog) so grid + chips never disagree.
  const q = searchText.trim().toLowerCase();
  const searchedEntries = q
    ? fullEntries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.tags?.some(t => t.toLowerCase().includes(q)),
      )
    : fullEntries;
  const displayedEntries = filterByChip(searchedEntries, selectedChip);

  // Local-folder permission state (drives the in-grid re-grant prompt).
  const localNeedsPermission =
    isLocalTab && snapshot.catalogErrors.get(resolvedActiveTabId ?? '') === LOCAL_NEEDS_PERMISSION;

  // Library dropdown items — catalog URLs (url / github / local) + Asset
  // Manager connections, each carrying the kind/status the selector needs to
  // render its icon and per-row remove/refresh actions.
  const libraryItems: LibraryItem[] = [
    ...visibleCatalogUrls.map((url): LibraryItem => {
      const catalog = snapshot.catalogs.get(url);
      const err = snapshot.catalogErrors.get(url);
      const local = url.startsWith('local:');
      return {
        id: url,
        label: local
          ? (catalog?.name?.replace(/^Local:\s*/, '') ?? 'Local folder')
          : (catalog?.name ?? (err ? 'Error' : 'Loading…')),
        kind: local ? 'local' : isGitHubRepoScanUrl(url) ? 'github' : 'url',
        needsPermission: err === LOCAL_NEEDS_PERMISSION,
        error: !!err && err !== LOCAL_NEEDS_PERMISSION,
      };
    }),
    ...amConnections.map((cs): LibraryItem => ({
      id: `am:${cs.conn.id}`,
      label: cs.conn.label,
      kind: 'cloud',
      cloudStatus: cs.connected ? 'connected' : cs.connecting ? 'connecting' : 'error',
    })),
  ];

  const handleSelectLibrary = (id: string): void => {
    switchToLibrary(id);
    // Local folder whose permission lapsed: this click is a user gesture, so
    // `requestPermission()` is allowed — re-grant + load.
    if (id.startsWith('local:') && snapshot.catalogErrors.get(id) === LOCAL_NEEDS_PERMISSION) {
      void store.activateLocalFolder();
    }
  };

  const handleRemoveLibrary = (id: string): void => {
    if (id.startsWith('am:')) cloudStore?.removeConnection(id.slice(3));
    else if (id.startsWith('local:')) void store.removeLocalFolder();
    else store.removeCatalog(id);
  };

  // Chip row is redundant when a single facet already covers every entry
  // (e.g. one category == all items). Show it only when it adds filtering value.
  const showChips = chips.length > 1 || (chips.length === 1 && chips[0].count < fullEntries.length);

  // Resolve the single "empty" state shown instead of the card grid (null =>
  // render the grid). Order: no libraries → permission re-grant → load error →
  // no results.
  const nonPermissionError = activeError && activeError !== LOCAL_NEEDS_PERMISSION ? activeError : null;
  let emptyContent: ReactNode = null;
  if (allTabIds.length === 0) {
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          No libraries loaded. Click [+] to add a library.
        </Typography>
      </Box>
    );
  } else if (localNeedsPermission) {
    // Browser dropped the File System Access permission between sessions — the
    // folder is still remembered, we just need read access re-granted. One
    // click here runs `requestPermission()` inside a user gesture.
    emptyContent = (
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.25 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center', fontSize: 11 }}>
          Browser permission for this folder has expired. Grant read access again to load the local library.
        </Typography>
        <Button
          size="small"
          variant="contained"
          startIcon={<FolderOpen sx={{ fontSize: 14 }} />}
          onClick={() => { void store.activateLocalFolder(); }}
          sx={{ textTransform: 'none', fontSize: 11 }}
        >
          Re-grant access
        </Button>
      </Box>
    );
  } else if (nonPermissionError) {
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: '#ef5350' }}>
          Library unavailable: {nonPermissionError}
        </Typography>
      </Box>
    );
  } else if (displayedEntries.length === 0) {
    const filtering = searchText.trim() !== '' || selectedChip !== null;
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {filtering ? 'No matching components' : isLocalTab ? 'No assets in folder' : 'Loading...'}
        </Typography>
      </Box>
    );
  }

  // Small count caption — only when the grid is showing AND the chip row is
  // hidden (otherwise the "All (N)" chip already carries the count).
  const countLabel = emptyContent === null && !showChips && fullEntries.length > 0
    ? `${fullEntries.length} ${isLocalTab ? 'asset' : 'component'}${fullEntries.length !== 1 ? 's' : ''}`
    : undefined;

  return (
    <>
      {isMobile ? (
        /* Compact layout: a horizontal thumbnail strip docked above the bottom
           nav instead of the fullscreen panel — keeps the scene visible. */
        <MobileLibraryStrip
          entries={displayedEntries}
          plugin={plugin}
          snapshot={snapshot}
          isAmTab={isAmTab}
          libraryItems={libraryItems}
          activeId={resolvedActiveTabId}
          onSelect={handleSelectLibrary}
          onRemove={handleRemoveLibrary}
          onRefreshLocal={handleRefreshLocalFolder}
          onAdd={() => setAddUrlOpen(true)}
          onClose={handleClose}
        />
      ) : (
      /* Right-docked library window (toggled from the toolbar Library button). */
      <LeftPanel
        title="Library"
        anchor="right"
        onClose={handleClose}
        // Width is driven by the panel manager — it owns persistence via
        // localStorage. Falling back to the default keeps the panel usable
        // before the first resize is recorded.
        width={lpmSnapshot.right.activePanelWidth || LAYOUT_PANEL_WIDTH}
        resizable
        minWidth={280}
        maxWidth={600}
        onResize={(w) => lpm.open(PANEL_ID, w, 'right')}
        footer={
          snapshot.placed.length > 0 ? (
            <Box sx={{ px: 1.5, py: 0.75 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                {snapshot.placed.length} object{snapshot.placed.length !== 1 ? 's' : ''} placed
              </Typography>
            </Box>
          ) : null
        }
      >
        {/* Library switcher — full-width dropdown with per-library remove. */}
        <LibrarySelector
          items={libraryItems}
          activeId={resolvedActiveTabId}
          onSelect={handleSelectLibrary}
          onRemove={handleRemoveLibrary}
          onRefresh={(id) => { if (id.startsWith('local:')) void handleRefreshLocalFolder(); }}
          onAdd={() => setAddUrlOpen(true)}
        />

        {/* Content area — the Asset Manager tab delegates to the private cloud
            component (its own data model + download flow); every other catalog
            source shares the CatalogBrowser shell. */}
        {isAmTab && activeAmId && plugin?.extension?.cloudTabComponent && cloudStore ? (
          <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {(() => {
              const CloudTab = plugin.extension.cloudTabComponent;
              return <CloudTab plugin={plugin} cloudStore={cloudStore} connectionId={activeAmId} onEdit={handleEditAmConnection} />;
            })()}
          </Box>
        ) : (
          <CatalogBrowser
            headerText={countLabel}
            searchText={searchText}
            onSearchChange={setSearchText}
            searchPlaceholder={isLocalTab ? 'Search assets...' : 'Search...'}
            chips={showChips ? chips : []}
            totalCount={fullEntries.length}
            selectedChip={selectedChip}
            onSelectChip={setSelectedChip}
            empty={emptyContent !== null}
            emptyContent={emptyContent}
          >
            {displayedEntries.map((entry) => (
              <ThumbnailCard
                key={entry.id}
                entry={entry}
                isPlacing={snapshot.placementMode === entry.id}
                isPending={snapshot.thumbnailPending.has(entry.id)}
                plugin={plugin}
              />
            ))}
          </CatalogBrowser>
        )}
      </LeftPanel>
      )}

      {/* Add Library Dialog (URL or Asset Manager) */}
      <Dialog open={addUrlOpen} onClose={() => setAddUrlOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, pb: 0 }}>Add Library</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Tabs value={addDialogTab} onChange={(_, v) => setAddDialogTab(v)} sx={{ mb: 1, minHeight: 32, '& .MuiTab-root': { minHeight: 32, textTransform: 'none', fontSize: 12 } }}>
            <Tab label="URL" />
            <Tab label="GitHub" icon={<GitHub sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
            <Tab label="Asset Manager" icon={<Cloud sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
            {store?.isLocalFolderSupported && (
              <Tab label="Local Folder" icon={<FolderOpen sx={{ fontSize: 12 }} />} iconPosition="start" sx={{ gap: 0.5 }} />
            )}
          </Tabs>

          {addDialogTab === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Load a component library from a public <Box component="code" sx={{ fontFamily: 'monospace', px: 0.5, py: 0.125, bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 0.5 }}>catalog.json</Box> URL.
              </Typography>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Catalog URL"
                placeholder="https://library.example.com/catalog.json"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddCatalog(); }}
              />
            </Box>
          )}

          {addDialogTab === 1 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Paste a GitHub repository or folder URL — it is scanned for <Box component="code" sx={{ fontFamily: 'monospace', px: 0.5, py: 0.125, bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 0.5 }}>.glb</Box> files automatically (no <Box component="code" sx={{ fontFamily: 'monospace', px: 0.5, py: 0.125, bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 0.5 }}>catalog.json</Box> needed). A direct catalog.json URL also works.
              </Typography>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="GitHub URL"
                placeholder="https://github.com/user/repo/tree/main/library"
                value={ghUrl}
                onChange={(e) => setGhUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddGitHub(); }}
              />
            </Box>
          )}

          {addDialogTab === 2 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Connect to a Unity Cloud Asset Manager project. Credentials are stored in this browser only.
              </Typography>
              <TextField size="small" fullWidth label="Name (optional)" placeholder="My Asset Library"
                value={amLabel} onChange={(e) => setAmLabel(e.target.value)} />
              <TextField size="small" fullWidth label="Project ID" required
                value={amProjId} onChange={(e) => setAmProjId(e.target.value)} />
              <TextField size="small" fullWidth label="Service Account Key ID" required
                value={amKeyId} onChange={(e) => setAmKeyId(e.target.value)} />
              <TextField size="small" fullWidth label="Secret Key" type="password" required
                value={amSecret} onChange={(e) => setAmSecret(e.target.value)} />
            </Box>
          )}

          {addDialogTab === 3 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Pick your working folder. The planner reads <Box component="code" sx={{ fontFamily: 'monospace', px: 0.5, py: 0.125, bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 0.5 }}>library/</Box> inside it. Subfolder names become category headers.
              </Typography>
              <Box sx={{ px: 1.5, py: 1, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1, fontFamily: 'monospace', fontSize: 10, color: 'text.secondary', lineHeight: 1.6 }}>
                <Box component="span" sx={{ color: 'text.primary' }}>{'<working-folder>/'}</Box><br />
                {'└── library/'}<br />
                {'    ├── conveyor/   *.glb'}<br />
                {'    ├── robot/      *.glb'}<br />
                {'    └── machine/    *.glb'}
              </Box>
              <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                If a working folder is already set in Settings → Local Folder, it is reused. The handle is remembered across sessions (you may need to re-grant read access after a reload).
              </Typography>
              <Button
                variant="contained"
                startIcon={<FolderOpen />}
                onClick={handleAddLocalFolder}
                disabled={addLoading}
                fullWidth
                sx={{ textTransform: 'none' }}
              >
                {addLoading ? 'Scanning...' : 'Choose Folder'}
              </Button>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddUrlOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          {addDialogTab === 0 && (
            <Button onClick={handleAddCatalog} disabled={!addUrl.trim() || addLoading} variant="contained" sx={{ textTransform: 'none' }}>
              {addLoading ? 'Loading...' : 'Add'}
            </Button>
          )}
          {addDialogTab === 1 && (
            <Button onClick={handleAddGitHub} disabled={!ghUrl.trim() || addLoading} variant="contained" sx={{ textTransform: 'none' }}>
              {addLoading ? 'Loading...' : 'Add'}
            </Button>
          )}
          {addDialogTab === 2 && (
            <Button onClick={handleAddAssetManager} disabled={!amProjId.trim() || !amKeyId.trim() || !amSecret.trim()} variant="contained" sx={{ textTransform: 'none' }}>
              Connect
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Edit AM Connection Dialog */}
      <Dialog open={editAmId !== null} onClose={() => setEditAmId(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, pb: 0 }}>Edit Connection</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
            <TextField size="small" fullWidth label="Name (optional)" placeholder="My Asset Library"
              value={editAmLabel} onChange={(e) => setEditAmLabel(e.target.value)} />
            <TextField size="small" fullWidth label="Project ID" required
              value={editAmProjId} onChange={(e) => setEditAmProjId(e.target.value)} />
            <TextField size="small" fullWidth label="Service Account Key ID" required
              value={editAmKeyId} onChange={(e) => setEditAmKeyId(e.target.value)} />
            <TextField size="small" fullWidth label="Secret Key" type="password" required
              value={editAmSecret} onChange={(e) => setEditAmSecret(e.target.value)} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditAmId(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button onClick={handleSaveAmEdit} disabled={!editAmProjId.trim() || !editAmKeyId.trim() || !editAmSecret.trim()} variant="contained" sx={{ textTransform: 'none' }}>
            Save & Reconnect
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ─── Mobile: collapsed tab ──────────────────────────────────────────────

/** Small bottom tab shown on the compact layout while the planner is active
 *  and the library is closed. Tapping it opens the horizontal strip. Sits above
 *  the bottom nav strips (ActivityBar / ButtonPanel). */
function MobileLibraryTab({ onOpen }: { onOpen: () => void }) {
  return (
    <Box
      sx={{
        position: 'fixed', left: 0, right: 0,
        bottom: `calc(${MOBILE_NAV_CLEARANCE}px + env(safe-area-inset-bottom, 0px))`,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={6}
        data-ui-panel
        onClick={onOpen}
        sx={{
          pointerEvents: 'auto', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1.5, py: 0.75, borderRadius: 1,
          backgroundColor: `${WINDOW_DARK_BG} !important`,
        }}
      >
        <ViewSidebar sx={{ fontSize: 18, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 12 }}>Library</Typography>
        <KeyboardArrowUp sx={{ fontSize: 16, color: 'text.secondary' }} />
      </Paper>
    </Box>
  );
}

// ─── Mobile: horizontal strip ───────────────────────────────────────────

interface MobileLibraryStripProps {
  entries: LibraryCatalogEntry[];
  plugin: LayoutPlannerPlugin;
  snapshot: LayoutSnapshot;
  isAmTab: boolean;
  libraryItems: LibraryItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRefreshLocal: () => void | Promise<void>;
  onAdd: () => void;
  onClose: () => void;
}

/** Compact-layout library: a one-row, horizontally scrollable thumbnail strip
 *  docked above the bottom nav. Keeps the 3D scene visible (unlike the
 *  fullscreen panel) — tap a card to enter placement mode, then tap the scene. */
function MobileLibraryStrip({
  entries, plugin, snapshot, isAmTab, libraryItems, activeId,
  onSelect, onRemove, onRefreshLocal, onAdd, onClose,
}: MobileLibraryStripProps) {
  // Single combined menu (library switch + manage) opened from the floating ⋮.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => setMenuAnchor(null);
  const activeItem = libraryItems.find((i) => i.id === activeId) ?? null;

  return (
    <Box
      sx={{
        position: 'fixed', left: 0, right: 0,
        bottom: `calc(${MOBILE_NAV_CLEARANCE}px + env(safe-area-inset-bottom, 0px))`,
        zIndex: LEFT_PANEL_ZINDEX, pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={6}
        data-ui-panel
        sx={{
          position: 'relative',
          pointerEvents: 'auto',
          backgroundColor: `${WINDOW_DARK_BG} !important`,
          borderRadius: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* No header row — just the scrollable thumbnail row. Right padding clears
            the floating controls so the last card isn't hidden behind them. */}
        <Box
          className={RV_SCROLL_CLASS}
          sx={{
            display: 'flex', flexDirection: 'row', gap: 0.5, p: 0.75, pr: 8,
            overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch',
            '& > *': { flexShrink: 0 },
          }}
        >
          {entries.length === 0 ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', px: 1, py: 1.5 }}>
              {isAmTab ? 'Asset Manager not available on mobile' : 'No components'}
            </Typography>
          ) : (
            entries.map((entry) => (
              <Box key={entry.id} sx={{ width: MOBILE_CARD_WIDTH }}>
                <ThumbnailCard
                  entry={entry}
                  isPlacing={snapshot.placementMode === entry.id}
                  isPending={snapshot.thumbnailPending.has(entry.id)}
                  plugin={plugin}
                />
              </Box>
            ))
          )}
        </Box>

        {/* Tap-to-place hint (no drag-and-drop on touch). Reflects the current
            placement state so the user knows what to tap next. */}
        {entries.length > 0 && (
          <Box sx={{ px: 1, pb: 0.5, pt: 0.25 }}>
            <Typography
              sx={{
                fontSize: 9.5, textAlign: 'center',
                color: snapshot.placementMode ? 'primary.light' : 'text.disabled',
              }}
            >
              {snapshot.placementMode ? 'Tap in the scene to place · tap part again to cancel' : 'Tap a part, then tap the scene to place'}
            </Typography>
          </Box>
        )}

        {/* Floating controls (top-right): combined library/actions menu + close.
            No header row keeps the strip as low as possible. */}
        <Box sx={{ position: 'absolute', top: 2, right: 2, display: 'flex', gap: 0.25 }}>
          <IconButton
            size="small"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={{ color: 'text.secondary', bgcolor: 'rgba(0,0,0,0.45)', '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' }, p: 0, width: 22, height: 22 }}
            aria-label="Library menu"
          >
            <MoreVert sx={{ fontSize: 15 }} />
          </IconButton>
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ color: 'text.secondary', bgcolor: 'rgba(0,0,0,0.45)', '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' }, p: 0, width: 22, height: 22 }}
            aria-label="Close library"
          >
            <Close sx={{ fontSize: 15 }} />
          </IconButton>
        </Box>

        {/* Combined menu: switch active library + manage (refresh/remove/add). */}
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
          {libraryItems.map((item) => (
            <MenuItem
              key={item.id}
              selected={item.id === activeId}
              onClick={() => { onSelect(item.id); closeMenu(); }}
              sx={{ fontSize: 12 }}
            >
              <ListItemIcon sx={{ minWidth: 26 }}>
                {item.id === activeId
                  ? <Check sx={{ fontSize: 16, color: 'primary.main' }} />
                  : <LinkIcon sx={{ fontSize: 16 }} />}
              </ListItemIcon>
              {item.label}
            </MenuItem>
          ))}
          {libraryItems.length > 0 && <Divider />}
          {activeItem?.kind === 'local' && (
            <MenuItem onClick={() => { onRefreshLocal(); closeMenu(); }} sx={{ fontSize: 12 }}>
              <ListItemIcon sx={{ minWidth: 26 }}><Refresh sx={{ fontSize: 16 }} /></ListItemIcon>
              Refresh folder
            </MenuItem>
          )}
          <MenuItem disabled={!activeItem} onClick={() => { if (activeItem) onRemove(activeItem.id); closeMenu(); }} sx={{ fontSize: 12 }}>
            <ListItemIcon sx={{ minWidth: 26 }}><Delete sx={{ fontSize: 16 }} /></ListItemIcon>
            Remove library
          </MenuItem>
          <MenuItem onClick={() => { onAdd(); closeMenu(); }} sx={{ fontSize: 12 }}>
            <ListItemIcon sx={{ minWidth: 26 }}><Add sx={{ fontSize: 16 }} /></ListItemIcon>
            Add library…
          </MenuItem>
        </Menu>
      </Paper>
    </Box>
  );
}

// ─── Thumbnail Card (draggable) ─────────────────────────────────────────

interface ThumbnailCardProps {
  entry: LibraryCatalogEntry;
  isPlacing: boolean;
  /** True while the preview is being auto-generated in the background. */
  isPending: boolean;
  plugin: LayoutPlannerPlugin;
}

const ThumbnailCard = memo(function ThumbnailCard({ entry, isPlacing, isPending, plugin }: ThumbnailCardProps) {
  // Preview generation state — kept local because it only matters for the
  // single card showing the camera button. Multiple cards can generate in
  // parallel; each tracks its own progress.
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const errorClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  // Hover tooltip showing the component's general behavior description. Suppressed
  // while dragging (controlled `open`) so it doesn't float over the drag ghost.
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const description = behaviorDescription(entry);

  const handleClick = () => {
    // Splat entries: place directly at origin (no drag/placement mode — splats are too large).
    // Surface placement failures so the click doesn't appear to do nothing
    // when the gaussian-splat library throws (e.g. unsupported format).
    if (entry.splatUrl) {
      plugin.placeComponent(entry, [0, 0, 0]).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LayoutPlanner] Failed to place splat "${entry.name}":`, err);
        showInfoOverlay(`Splat konnte nicht platziert werden: ${msg}`);
      });
      return;
    }
    // Toggle: click same entry again to cancel
    plugin.store.setPlacementMode(isPlacing ? null : entry.id);
  };

  const runGeneratePreview = useCallback(async () => {
    if (generating) return;
    if (errorClearTimer.current) {
      clearTimeout(errorClearTimer.current);
      errorClearTimer.current = null;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const result = await plugin.saveThumbnail(entry.id, entry.glbUrl ?? '');
      // `result` is null when generation succeeded in-memory but persistence
      // was skipped (e.g. user denied write access on the local folder, or
      // the dev-server route is unavailable). The in-memory thumbnail is
      // still set on the store, so the card switches away from the camera
      // fallback — no error in that case.
      if (!result && !entry.thumbnailUrl) {
        setGenError('Preview konnte nicht erzeugt werden — Schreibrechte verweigert oder GLB-Ladefehler');
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      // Auto-dismiss the error indicator after a while so the card returns
      // to a neutral state and the user can retry without manual cleanup.
      errorClearTimer.current = setTimeout(() => setGenError(null), 6000);
    }
  }, [generating, plugin, entry.id, entry.glbUrl, entry.thumbnailUrl]);

  const handleGeneratePreview = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void runGeneratePreview();
  }, [runGeneratePreview]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCtxUpdate = useCallback(() => {
    setCtxPos(null);
    void runGeneratePreview();
  }, [runGeneratePreview]);

  const handleDragStart = (e: React.DragEvent) => {
    setDragging(true);
    setHovered(false);
    setLayoutDragData(e.dataTransfer, entry);
    e.dataTransfer.effectAllowed = 'copy';

    // Store footprint as a MIME type for dragover to read
    if (entry.footprintMm) {
      e.dataTransfer.setData(`x-footprint/${entry.footprintMm[0]}/${entry.footprintMm[1]}`, '');
    }

    // Set drag entry so the 3D ghost preview appears during drag
    plugin.setDragEntry(entry);

    // Hide the browser's default HTML5 drag preview (card clone) —
    // the 3D ghost on the floor replaces it.
    suppressDragImage(e);
  };

  const handleDragEnd = () => {
    setDragging(false);
    plugin.setDragEntry(null);
  };

  const isSplat = !!entry.splatUrl;

  return (
    <>
    <Tooltip
      title={description ?? ''}
      open={!!description && hovered && !dragging}
      placement="right"
      arrow
      disableInteractive
    >
    <Box
      draggable={!isSplat}
      onDragStart={isSplat ? undefined : handleDragStart}
      onDragEnd={isSplat ? undefined : handleDragEnd}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        p: 0.5,
        borderRadius: 1,
        cursor: isSplat ? 'pointer' : (isPlacing ? 'crosshair' : 'grab'),
        bgcolor: isPlacing ? 'rgba(79, 195, 247, 0.15)' : 'rgba(255,255,255,0.03)',
        border: isPlacing ? '1px solid rgba(79, 195, 247, 0.5)' : '1px solid rgba(255,255,255,0.06)',
        '&:hover': { bgcolor: 'rgba(79, 195, 247, 0.08)', borderColor: 'rgba(79, 195, 247, 0.2)' },
        transition: 'all 0.15s',
        userSelect: 'none',
      }}
    >
      {entry.thumbnailUrl ? (
        <Box
          component="img"
          src={entry.thumbnailUrl}
          alt={entry.name}
          sx={{
            width: '100%',
            aspectRatio: '1',
            objectFit: 'cover',
            borderRadius: 0.5,
            bgcolor: 'rgba(255,255,255,0.05)',
          }}
          draggable={false}
        />
      ) : entry.virtual ? (
        <Box
          sx={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: 0.5,
            bgcolor: 'rgba(79,195,247,0.08)',
            border: '1px dashed rgba(79,195,247,0.3)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
          }}
        >
          <TimerOutlined sx={{ fontSize: 28, color: 'rgba(79,195,247,0.6)' }} />
          <Typography sx={{ fontSize: 8, color: 'rgba(79,195,247,0.5)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {entry.desType?.replace('DES', '') ?? 'Virtual'}
          </Typography>
        </Box>
      ) : entry.splatUrl ? (
        <Box
          sx={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: 0.5,
            bgcolor: 'rgba(139,195,74,0.08)',
            border: '1px dashed rgba(139,195,74,0.3)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
          }}
        >
          <Landscape sx={{ fontSize: 28, color: 'rgba(139,195,74,0.6)' }} />
          <Typography sx={{ fontSize: 8, color: 'rgba(139,195,74,0.5)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Splat
          </Typography>
        </Box>
      ) : (
        <Box
          sx={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: 0.5,
            bgcolor: 'rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <Tooltip
            title={
              (generating || isPending) ? 'Generating preview…'
                : genError ? genError
                : 'Generate preview'
            }
            placement="top"
          >
            <Box component="span" sx={{ display: 'inline-flex' }}>
              <IconButton
                size="small"
                disabled={generating || isPending}
                sx={{
                  color: genError ? '#ef5350' : 'rgba(255,255,255,0.25)',
                  '&:hover': { color: genError ? '#ef5350' : 'rgba(79,195,247,0.8)' },
                  '&.Mui-disabled': { color: 'rgba(79,195,247,0.6)' },
                }}
                onClick={handleGeneratePreview}
              >
                {(generating || isPending)
                  ? <CircularProgress size={18} sx={{ color: 'rgba(79,195,247,0.8)' }} />
                  : genError
                    ? <ErrorOutline sx={{ fontSize: 20 }} />
                    : <CameraAlt sx={{ fontSize: 20 }} />
                }
              </IconButton>
            </Box>
          </Tooltip>
        </Box>
      )}
      <Typography
        sx={{
          fontSize: 9,
          color: 'text.secondary',
          textAlign: 'center',
          lineHeight: 1.2,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.name}
      </Typography>
      {entry.tags && entry.tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25, justifyContent: 'center', mt: 0.125 }}>
          {entry.tags.map(tag => (
            <Typography
              key={tag}
              component="span"
              sx={{
                fontSize: 7,
                lineHeight: 1.2,
                px: 0.5,
                py: 0.125,
                borderRadius: 0.5,
                bgcolor: 'rgba(79, 195, 247, 0.1)',
                color: 'rgba(79, 195, 247, 0.7)',
                whiteSpace: 'nowrap',
              }}
            >
              {tag}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
    </Tooltip>
    <Menu
      open={ctxPos !== null}
      onClose={() => setCtxPos(null)}
      anchorReference="anchorPosition"
      anchorPosition={ctxPos ? { top: ctxPos.y, left: ctxPos.x } : undefined}
    >
      <MenuItem
        onClick={handleCtxUpdate}
        disabled={generating || !entry.glbUrl}
        sx={{ fontSize: 12 }}
      >
        <CameraAlt sx={{ fontSize: 14, mr: 1 }} />
        {entry.thumbnailUrl ? 'Update Preview' : 'Generate Preview'}
      </MenuItem>
    </Menu>
    </>
  );
});
