// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ActivityBar — the VSCode-style left vertical icon strip that owns the buttons
 * which OPEN a left-docked window. Core windows (Models, Hierarchy, Annotations,
 * Settings) render directly; plugins contribute via the `activity-bar` slot
 * (e.g. Connect, Order Manager). All open/close state lives in leftPanelManager
 * / the editor plugin (single source of truth); the docked windows render
 * edge-to-edge to the bar's right (see LeftPanel.buildPanelSx).
 *
 * NOT to be confused with the floating ButtonPanel, which hosts contextual
 * mode TOOLS (planner delete/grid/snap, measurement, …) as a floating toolbar.
 *
 * Desktop: flush vertical bar (width ACTIVITY_BAR_WIDTH). Mobile: bottom strip.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Paper, IconButton, Tooltip, Divider, Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import { FolderOpen, AccountTree, PushPin, Settings, ViewInAr, Memory, MoreVert } from '@mui/icons-material';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useAiActivity } from './ai-activity-store';
import { requestSettingsTab } from './settings-tab-store';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import {
  ACTIVITY_BAR_WIDTH, LEFT_PANEL_ZINDEX,
  SCENE_PANEL_WIDTH, SETTINGS_PANEL_WIDTH,
} from './layout-constants';
import { isSettingsLocked } from './rv-app-config';
import { getSceneStore } from './scene/scene-store-singleton';
import { useActiveContexts, evaluateVisibilityRule } from './ui-context-store';
import { LogoBadge } from './ButtonPanel';
import { MultiuserButton } from './MultiuserPanel';
import type { WebXRPluginAPI } from '../types/plugin-types';

/** One icon button in the activity bar. */
function ActivityButton({
  title, active, onClick, placement, children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  placement: 'right' | 'top';
  children: ReactNode;
}) {
  return (
    <Tooltip title={title} placement={placement}>
      <IconButton size="medium" color={active ? 'primary' : 'inherit'} onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

export function ActivityBar() {
  const viewer = useViewer();
  const { plugin, state: editorState } = useEditorPlugin();
  const isMobile = useMobileLayout();
  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const sceneStore = getSceneStore();
  const placement = isMobile ? 'top' as const : 'right' as const;
  // Mobile: anchor for the top-right "⋮" window-opener menu.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // Plugin-contributed window-opener buttons (Connect, Order Manager, …).
  const contexts = useActiveContexts();
  const slotEntries = useSlot('activity-bar').filter(
    (e) => !e.visibilityRule || evaluateVisibilityRule(e.visibilityRule, contexts),
  );
  const pluginButtons = slotEntries.map((entry, i) => {
    const Comp = entry.component;
    return <Comp key={`act-${i}`} viewer={viewer} />;
  });

  // ── Core left-window button handlers (single source of truth = lpm/plugin) ──
  const toggleScene = () => lpm.toggle('scene', SCENE_PANEL_WIDTH);
  const toggleHierarchy = () => plugin?.togglePanel();
  const toggleAnnotations = () => lpm.toggle('annotations', 280);
  const toggleSettings = () => {
    const open = editorState.settingsOpen;
    plugin?.setSettingsOpen(!open);
    if (!open) lpm.open('settings', SETTINGS_PANEL_WIDTH);
    else lpm.close('settings');
  };

  // AI activity button (above Settings, only while the MCP bridge is connected).
  // Click opens the Settings panel on the AI tab. The status text rides beside
  // it over the 3D scene via AiActivityOverlay.
  const mcp = useMcpBridge();
  const aiActivity = useAiActivity();
  const openAiSettings = () => {
    if (!editorState.settingsOpen) {
      plugin?.setSettingsOpen(true);
      lpm.open('settings', SETTINGS_PANEL_WIDTH);
    }
    requestSettingsTab(5); // AI tab
  };

  // Hierarchy is desktop-only (no usable tree on phones).
  const coreTop = (
    <>
      {sceneStore && (
        <ActivityButton title="Models" active={panelSnapshot.activePanel === 'scene'} onClick={toggleScene} placement={placement}>
          <FolderOpen />
        </ActivityButton>
      )}
      {plugin && !isMobile && (
        <ActivityButton title="Hierarchy" active={editorState.panelOpen} onClick={toggleHierarchy} placement={placement}>
          <AccountTree />
        </ActivityButton>
      )}
      <ActivityButton title="Annotations" active={panelSnapshot.activePanel === 'annotations'} onClick={toggleAnnotations} placement={placement}>
        <PushPin />
      </ActivityButton>
    </>
  );

  const settingsButton = !isSettingsLocked() && plugin && (
    <ActivityButton title="Settings" active={editorState.settingsOpen} onClick={toggleSettings} placement={placement}>
      <Settings />
    </ActivityButton>
  );

  // Mobile-only AR entry (moved here from the removed top bar). Shown on any
  // touch device whose WebXR supports AR.
  const xrPlugin = viewer.getPlugin<WebXRPluginAPI>('webxr');
  const hasTouchInput = isMobile || navigator.maxTouchPoints > 0;
  const arButton = hasTouchInput && xrPlugin?.arSupported && (
    <ActivityButton title="Start AR" active={false} onClick={() => xrPlugin?.startAR()} placement={placement}>
      <ViewInAr />
    </ActivityButton>
  );

  if (isMobile) {
    // Mobile: a single "⋮" menu in the top-right corner replaces the bottom nav
    // strip. It holds the window openers (Models, Annotations, Settings). PLC
    // Connect, the Hierarchy tree and the AI bridge are intentionally NOT exposed
    // on mobile. Multiuser + AR ride as their own buttons beside the menu.
    const closeMenu = () => setMenuAnchor(null);
    const run = (fn: () => void) => () => { fn(); closeMenu(); };
    return (
      <Box
        sx={{
          position: 'fixed',
          top: 'calc(8px + env(safe-area-inset-top, 0px))',
          right: 8,
          zIndex: LEFT_PANEL_ZINDEX,
          display: 'flex', alignItems: 'center', pointerEvents: 'auto',
        }}
      >
        {/* One pill holding Multiuser / AR / ⋮ at top-bar height (≈34px). */}
        <Paper
          elevation={4}
          data-ui-panel
          sx={{
            borderRadius: 1, display: 'flex', alignItems: 'center',
            bgcolor: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(12px)',
            '& .MuiIconButton-root': { width: 40, height: 34, borderRadius: 1, color: 'rgba(255,255,255,0.92)' },
            '& .MuiSvgIcon-root': { fontSize: 20 },
          }}
        >
          <MultiuserButton placement="top" />
          {arButton}
          <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="Menu">
            <MoreVert />
          </IconButton>
        </Paper>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
          {sceneStore && (
            <MenuItem onClick={run(toggleScene)} sx={{ fontSize: 13 }}>
              <ListItemIcon><FolderOpen fontSize="small" /></ListItemIcon>
              <ListItemText>Models</ListItemText>
            </MenuItem>
          )}
          <MenuItem onClick={run(toggleAnnotations)} sx={{ fontSize: 13 }}>
            <ListItemIcon><PushPin fontSize="small" /></ListItemIcon>
            <ListItemText>Annotations</ListItemText>
          </MenuItem>
          {settingsButton && (
            <MenuItem onClick={run(toggleSettings)} sx={{ fontSize: 13 }}>
              <ListItemIcon><Settings fontSize="small" /></ListItemIcon>
              <ListItemText>Settings</ListItemText>
            </MenuItem>
          )}
        </Menu>
      </Box>
    );
  }

  // Desktop: flush, edge-to-edge vertical activity bar, full height from the top.
  return (
    <Box
      data-ui-panel
      sx={{
        position: 'fixed', left: 0, top: 0, bottom: 0,
        width: ACTIVITY_BAR_WIDTH, zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25, py: 0.5,
        bgcolor: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(12px)',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.92)', pointerEvents: 'auto',
      }}
    >
      {/* realvirtual logo — the top-left corner mark; opens the About modal. */}
      <LogoBadge />
      <Divider flexItem sx={{ mx: 0.75, my: 0.25, borderColor: 'rgba(255,255,255,0.12)' }} />
      {coreTop}
      {pluginButtons.length > 0 && (
        <Divider flexItem sx={{ mx: 0.75, my: 0.25, borderColor: 'rgba(255,255,255,0.12)' }} />
      )}
      {pluginButtons}
      {/* Spacer pushes the bottom group (Multiuser, Settings) down (VSCode convention). */}
      <Box sx={{ flex: 1 }} />
      <MultiuserButton placement={placement} />
      {mcp.connected && (
        <ActivityButton title="AI Bridge" active={!!aiActivity} onClick={openAiSettings} placement={placement}>
          <Memory />
        </ActivityButton>
      )}
      {settingsButton}
    </Box>
  );
}
