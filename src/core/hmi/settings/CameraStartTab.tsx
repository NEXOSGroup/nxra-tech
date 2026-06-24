// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Settings panel tab — "Start View".
 *
 * Lets the user save/clear a per-model camera start position. The current
 * status is fetched via useCameraStartPos which reacts to model-loaded,
 * model-cleared, storage and CAMERA_START_CHANGED_EVENT.
 */

import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import type { UISlotProps } from '../../rv-ui-plugin';
import { useCameraStartPos } from '../../../hooks/use-camera-startpos';
import {
  saveCurrentCameraAsStart, clearCurrentCameraStart,
} from '../../../plugins/camera-startpos-plugin';
import { SettingsSection } from './settings-helpers';

export function CameraStartTab({ viewer }: UISlotProps) {
  const status = useCameraStartPos(viewer);
  const [toast, setToast] = useState<{ kind: 'error' | 'success'; msg: string } | null>(null);

  const handleSave = () => {
    const result = saveCurrentCameraAsStart(viewer);
    if (result === 'ok') setToast({ kind: 'success', msg: 'Start view saved for this model' });
    else if (result === 'no-model') setToast({ kind: 'error', msg: 'No model loaded' });
    else setToast({ kind: 'error', msg: 'Save failed — storage quota exceeded or disabled' });
    // Note: hook re-renders automatically via CAMERA_START_CHANGED_EVENT dispatched in saveStartPos
  };

  const handleClear = () => {
    if (clearCurrentCameraStart(viewer)) {
      setToast({ kind: 'success', msg: 'Start view cleared — using fit-to-bounds on next load' });
    }
  };

  const saveDisabled = !status.modelKey;
  const clearDisabled = !status.has || status.source === 'author';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="camera-start" title="Camera Start Position">
        <Typography variant="caption" sx={{ display: 'block', opacity: 0.8 }}>
          {status.modelKey ? `Model: ${status.modelKey}` : 'No model loaded'}
        </Typography>

        <Typography variant="body2">
          Status:&nbsp;
          {status.has
            ? status.source === 'author'
              ? 'Author default (from GLB)'
              : `Saved (user)${status.savedAt ? ` — ${new Date(status.savedAt).toLocaleString()}` : ''}`
            : 'No start view — using fit-to-bounds'}
        </Typography>

        <Stack direction="column" spacing={1} sx={{ maxWidth: 320 }}>
          <Button variant="contained" size="small" disabled={saveDisabled} onClick={handleSave}>
            Save current camera as start view
          </Button>
          <Button variant="outlined" size="small" disabled={clearDisabled} onClick={handleClear}>
            Clear start view
          </Button>
        </Stack>
      </SettingsSection>

      {toast && (
        <Alert severity={toast.kind === 'error' ? 'error' : 'success'}
               onClose={() => setToast(null)}>
          {toast.msg}
        </Alert>
      )}
    </Box>
  );
}
