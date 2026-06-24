// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useCallback, useEffect } from 'react';
import { Typography, Box, Button, Alert } from '@mui/material';
import { FolderOpen, Delete, Refresh } from '@mui/icons-material';
import {
  isSupported,
  selectWorkFolder,
  getWorkFolder,
  removeWorkFolder,
  getWorkFolderMeta,
  getSubfolder,
  listFiles,
  type WorkFolderMeta,
} from '../../engine/rv-local-filesystem';
import { SettingsSection } from './settings-helpers';

/**
 * LocalFolderTab — Settings tab for configuring the local working folder.
 *
 * Shows the currently selected folder, subfolder status, and allows
 * selecting/removing the folder. All features (models, library, splats)
 * read from well-known subfolders inside this single working folder.
 */
export function LocalFolderTab() {
  const [meta, setMeta] = useState<WorkFolderMeta | null>(getWorkFolderMeta());
  const [subfolderStatus, setSubfolderStatus] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  // True when a handle is remembered but the browser has dropped the read
  // permission for this session. We can detect this without prompting by
  // comparing `getWorkFolderMeta()` (always present once configured) against
  // a non-prompting `getWorkFolder(false)` (returns null without permission).
  const [needsPermission, setNeedsPermission] = useState(false);

  const refreshStatus = useCallback(async () => {
    const root = await getWorkFolder(false);
    if (!root) {
      setSubfolderStatus({});
      setNeedsPermission(getWorkFolderMeta() !== null);
      return;
    }
    setNeedsPermission(false);
    const status: Record<string, number | null> = {};
    for (const [key, name] of Object.entries({ models: 'models', library: 'library', splats: 'splats' })) {
      const sub = await getSubfolder(root, key as 'models' | 'library' | 'splats');
      if (sub) {
        // `library/` mirrors the planner loader — it now accepts GLB plus
        // all splat formats (the planner merges them into the same tab).
        // `splats/` stays splat-only; the planner merges it into the same
        // local catalog tab as `library/`.
        const exts = key === 'models'
          ? ['.glb']
          : key === 'library'
            ? ['.glb', '.splat', '.ksplat', '.ply']
            : ['.splat', '.ksplat', '.ply', '.pcd'];
        const files = await listFiles(sub, exts);
        status[name] = files.length;
      } else {
        status[name] = null;
      }
    }
    setSubfolderStatus(status);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleSelect = useCallback(async () => {
    setError(null);
    const handle = await selectWorkFolder();
    if (handle) {
      setMeta(getWorkFolderMeta());
      await refreshStatus();
    }
  }, [refreshStatus]);

  const handleRemove = useCallback(async () => {
    await removeWorkFolder();
    setMeta(null);
    setSubfolderStatus({});
  }, []);

  const handleRefresh = useCallback(async () => {
    setError(null);
    const root = await getWorkFolder(true);
    if (!root) {
      setError('Permission denied or folder no longer available.');
      return;
    }
    setMeta(getWorkFolderMeta());
    await refreshStatus();
  }, [refreshStatus]);

  if (!isSupported()) {
    return (
      <Box sx={{ p: 1.5 }}>
        <Alert severity="info" sx={{ fontSize: 11 }}>
          Local folder access requires Chrome or Edge browser.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Folder structure */}
      <SettingsSection id="localfolder-structure" title="Folder Structure">
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
          Pick one working folder. The viewer reads from these fixed subfolders — names must match exactly:
        </Typography>

        {/* Folder structure hint */}
        <Box sx={{ px: 1, py: 0.75, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1, fontFamily: 'monospace', fontSize: 10, color: 'text.secondary', lineHeight: 1.6 }}>
          <Box component="span" sx={{ color: 'text.primary' }}>{'<working-folder>/'}</Box><br />
          {'├── models/      ← full scenes shown in the model selector (.glb)'}<br />
          {'├── library/     ← Layout Planner components (.glb + splats)'}<br />
          {'│   ├── conveyor/    ← optional category subfolders'}<br />
          {'│   ├── robot/       (folder name = category in the planner UI)'}<br />
          {'│   └── machine/'}<br />
          {'└── splats/      ← reality-capture point clouds (.splat .ksplat .ply)'}<br />
          {'                  (merged into the Layout Planner library tab)'}
        </Box>
        <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
          Read-only. Other folders next to these are ignored. Recursion up to 5 levels deep.
        </Typography>
      </SettingsSection>

      {/* Working folder */}
      <SettingsSection id="localfolder-working-folder" title="Working Folder">
        {/* Current folder */}
        {meta ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <FolderOpen sx={{ fontSize: 16, color: 'primary.main' }} />
              <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.primary' }}>
                {meta.displayName}
              </Typography>
            </Box>

            {/* Subfolder status — only show counts when we actually have read
                permission, otherwise "not found" is misleading (the folder
                may have content; the browser just dropped the permission). */}
            {needsPermission ? (
              <Alert severity="info" sx={{ fontSize: 10, py: 0.5 }}>
                Permission expired for this session. Click <strong>Refresh</strong> to re-grant read access.
              </Alert>
            ) : (
              <Box sx={{ pl: 3, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {Object.entries(subfolderStatus).map(([name, count]) => (
                  <Typography key={name} sx={{ fontSize: 10, color: count === null ? 'text.disabled' : 'text.secondary' }}>
                    {name}/: {count === null ? 'not found' : `${count} file${count !== 1 ? 's' : ''}`}
                  </Typography>
                ))}
              </Box>
            )}

            {/* Actions */}
            <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
              <Button size="small" startIcon={<Refresh sx={{ fontSize: 14 }} />} onClick={handleRefresh} sx={{ fontSize: 10, textTransform: 'none' }}>
                Refresh
              </Button>
              <Button size="small" startIcon={<FolderOpen sx={{ fontSize: 14 }} />} onClick={handleSelect} sx={{ fontSize: 10, textTransform: 'none' }}>
                Change
              </Button>
              <Button size="small" startIcon={<Delete sx={{ fontSize: 14 }} />} onClick={handleRemove} color="error" sx={{ fontSize: 10, textTransform: 'none' }}>
                Remove
              </Button>
            </Box>
          </Box>
        ) : (
          <Button
            variant="contained"
            startIcon={<FolderOpen />}
            onClick={handleSelect}
            sx={{ textTransform: 'none', fontSize: 12 }}
          >
            Select Working Folder
          </Button>
        )}

        {error && (
          <Alert severity="warning" sx={{ fontSize: 10 }}>
            {error}
          </Alert>
        )}

        <Typography sx={{ fontSize: 9, color: 'text.disabled' }}>
          The folder handle is stored in the browser. On reload you may be prompted to re-grant access.
        </Typography>
      </SettingsSection>
    </Box>
  );
}
