// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GroupsTab — Settings tab for configuring group visibility defaults
 * and overlay exclusions.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Typography, Box, Checkbox, FormControlLabel } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
  type GroupVisibilitySettings,
} from '../group-visibility-store';
import type { GroupInfo } from '../../engine/rv-group-registry';
import { SettingsSection } from './settings-helpers';

export function GroupsTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadGroupVisibilitySettings());
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [defaultHidden, setDefaultHidden] = useState<string[]>(settingsRef.current.defaultHiddenGroups ?? []);
  const [excluded, setExcluded] = useState<string[]>(settingsRef.current.excludedFromOverlay ?? []);

  // Load groups from registry
  useEffect(() => {
    if (viewer.groups) {
      setGroups(viewer.groups.getAll());
    }
    const off = viewer.on('model-loaded', () => {
      if (viewer.groups) {
        setGroups(viewer.groups.getAll());
      }
    });
    return off;
  }, [viewer]);

  const persist = useCallback((patch: Partial<GroupVisibilitySettings>) => {
    Object.assign(settingsRef.current, patch);
    saveGroupVisibilitySettings(settingsRef.current);
  }, []);

  const handleDefaultHiddenToggle = useCallback((name: string, checked: boolean) => {
    setDefaultHidden(prev => {
      const next = checked ? [...prev, name] : prev.filter(n => n !== name);
      persist({ defaultHiddenGroups: next });
      // Also update the registry so showAll() respects the new defaults
      if (viewer.groups) {
        viewer.groups.setDefaultHiddenGroups(next);
      }
      return next;
    });
  }, [persist, viewer]);

  const handleExcludedToggle = useCallback((name: string, checked: boolean) => {
    setExcluded(prev => {
      const next = checked ? [...prev, name] : prev.filter(n => n !== name);
      persist({ excludedFromOverlay: next });
      return next;
    });
  }, [persist]);

  if (groups.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          No model loaded — load a model to see available groups.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Default Visibility */}
      <SettingsSection id="groups-default-visibility" title="Default Visibility">
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
          Groups hidden when model loads
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {groups.map(g => (
            <FormControlLabel
              key={`dh-${g.name}`}
              control={
                <Checkbox
                  size="small"
                  checked={defaultHidden.includes(g.name)}
                  onChange={(_, checked) => handleDefaultHiddenToggle(g.name, checked)}
                  sx={{ py: 0.25, px: 0.5 }}
                />
              }
              label={
                <Typography variant="body2" sx={{ fontSize: 12 }}>
                  {g.name}
                  <Typography component="span" sx={{ color: 'text.secondary', fontSize: 10, ml: 0.5 }}>
                    ({g.nodes.length} object{g.nodes.length !== 1 ? 's' : ''})
                  </Typography>
                </Typography>
              }
              sx={{ ml: 0, mr: 0 }}
            />
          ))}
        </Box>
      </SettingsSection>

      {/* Excluded from Overlay */}
      <SettingsSection id="groups-excluded-from-overlay" title="Excluded from Overlay">
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
          Groups not shown in Groups panel
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {groups.map(g => (
            <FormControlLabel
              key={`ex-${g.name}`}
              control={
                <Checkbox
                  size="small"
                  checked={excluded.includes(g.name)}
                  onChange={(_, checked) => handleExcludedToggle(g.name, checked)}
                  sx={{ py: 0.25, px: 0.5 }}
                />
              }
              label={
                <Typography variant="body2" sx={{ fontSize: 12 }}>
                  {g.name}
                </Typography>
              }
              sx={{ ml: 0, mr: 0 }}
            />
          ))}
        </Box>
      </SettingsSection>
    </Box>
  );
}
