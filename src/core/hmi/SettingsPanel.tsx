// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SettingsPanel — the Settings left-docked window.
 *
 * Extracted from TopBar so the activity bar can open it via leftPanelManager
 * without TopBar owning the (large) tab UI. Renders the scrollable settings
 * tabs inside a resizable LeftPanel.
 */

import { useState, useEffect } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { LeftPanel, clampWidth } from './LeftPanel';
import { SETTINGS_PANEL_WIDTH } from './layout-constants';
import { isTabLocked } from './rv-app-config';
import {
  BackupTab, MouseTab, VisualTab, InterfacesTab,
  MultiuserTab, McpTab, DevToolsTab, TestsTab, GroupsTab, LocalFolderTab,
} from './settings';
import { usePluginSettingsTabs, PluginSettingsTabContent } from './PluginSettingsTabs';

const LS_KEY_SETTINGS_WIDTH = 'rv-settings-panel-width';
const SETTINGS_MIN_WIDTH = 360;
const SETTINGS_MAX_WIDTH = 900;

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const viewer = useViewer();
  const [settingsTab, setSettingsTab] = useState(0);
  const pluginSettingsTabs = usePluginSettingsTabs(viewer);
  const muPlugin = viewer.getPlugin('multiuser');

  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(LS_KEY_SETTINGS_WIDTH));
    return clampWidth(stored, SETTINGS_MIN_WIDTH, SETTINGS_MAX_WIDTH) === stored && stored
      ? stored : SETTINGS_PANEL_WIDTH;
  });
  const handleResize = (w: number) => {
    setWidth(w);
    try { localStorage.setItem(LS_KEY_SETTINGS_WIDTH, String(w)); } catch { /* ignore */ }
  };

  // Keep leftPanelManager's tracked width in sync with the real (possibly
  // persisted/resized) panel width, so floating viewport controls and the
  // camera offset shift to the correct position immediately.
  const lpm = viewer.leftPanelManager;
  useEffect(() => {
    if (lpm.getActiveWidth('left') !== width) lpm.open('settings', width);
  }, [lpm, width]);

  return (
    <LeftPanel
      title="Settings"
      onClose={onClose}
      width={width}
      resizable
      minWidth={SETTINGS_MIN_WIDTH}
      maxWidth={SETTINGS_MAX_WIDTH}
      onResize={handleResize}
    >
      {/* Tabs - scrollable with visible scroll buttons on mobile (MUI hides them by default). */}
      <Tabs
        value={settingsTab}
        onChange={(_, v: number) => setSettingsTab(v)}
        variant="scrollable"
        scrollButtons
        allowScrollButtonsMobile
        sx={{
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          minHeight: 40,
          flexShrink: 0,
          '& .MuiTab-root': { minHeight: 40, py: 1, textTransform: 'none', fontSize: 13, minWidth: 0, px: { xs: 1, sm: 2 } },
          '& .MuiTabs-scrollButtons.Mui-disabled': { opacity: 0.3 },
        }}
      >
        {!isTabLocked('model') && <Tab label="Backup" value={0} />}
        {/* Plugin-registered settings-tab slots (value = 100..N), rendered right
            after Model so project-level tabs (e.g. "Start View") appear prominently.
            Rendered inline (not wrapped in a component) so MUI Tabs
            enumerates them via React.Children.map. */}
        {pluginSettingsTabs.map((entry, i) => (
          <Tab key={entry.pluginId ?? i} label={entry.label ?? 'Tab'} value={100 + i} />
        ))}
        {!isTabLocked('mouse') && <Tab label="Mouse & Touch" value={9} />}
        {!isTabLocked('visual') && <Tab label="Visual" value={1} />}
        {!isTabLocked('interfaces') && <Tab label="Interfaces" value={3} />}
        {!isTabLocked('multiuser') && muPlugin && <Tab label="Multiuser" value={4} />}
        {!isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && <Tab label="AI" value={5} />}
        {!isTabLocked('devtools') && <Tab label="Dev Tools" value={6} />}
        {!isTabLocked('tests') && <Tab label="Tests" value={7} />}
        {!isTabLocked('groups') && <Tab label="Groups" value={8} />}
        <Tab label="Local Folder" value={11} />
      </Tabs>

      {/* Tab content - minHeight: 0 for correct flexbox scrolling */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, px: 0.75, py: 1 }}>
        {settingsTab === 0 && !isTabLocked('model') && <BackupTab />}
        {settingsTab === 9 && !isTabLocked('mouse') && <MouseTab />}
        {settingsTab === 1 && !isTabLocked('visual') && <VisualTab />}
        {settingsTab === 3 && !isTabLocked('interfaces') && <InterfacesTab />}
        {settingsTab === 4 && !isTabLocked('multiuser') && muPlugin && <MultiuserTab />}
        {settingsTab === 5 && !isTabLocked('mcp') && viewer.getPlugin('mcp-bridge') && <McpTab />}
        {settingsTab === 6 && !isTabLocked('devtools') && <DevToolsTab />}
        {settingsTab === 7 && !isTabLocked('tests') && <TestsTab />}
        {settingsTab === 8 && !isTabLocked('groups') && <GroupsTab />}
        {settingsTab === 11 && <LocalFolderTab />}
        {settingsTab >= 100 && (
          <PluginSettingsTabContent viewer={viewer} value={settingsTab} offset={100} />
        )}
      </Box>
    </LeftPanel>
  );
}
