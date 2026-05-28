// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneConfirmDialog — "Unsaved changes" modal raised when the user is about
 * to switch models (or close the workspace) while the active working scene
 * has unsaved edits. Offers Save / Discard / Cancel.
 *
 * For working scenes that have no saved id yet, the primary action becomes
 * "Save as…" (since there is no saved id to overwrite).
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

interface SceneConfirmDialogProps {
  open: boolean;
  sceneName: string;
  /** True when the active working scene has a saved id (Save overwrites).
   *  False for unsaved working scenes (Save becomes Save as…). */
  canSave: boolean;
  onSave: () => void;
  onSaveAs: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function SceneConfirmDialog({
  open,
  sceneName,
  canSave,
  onSave,
  onSaveAs,
  onDiscard,
  onCancel,
}: SceneConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Unsaved changes</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          You have unsaved changes in <b>"{sceneName}"</b>. What would you like to do?
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onCancel} sx={{ textTransform: 'none', mr: 'auto' }}>
          Cancel
        </Button>
        <Button size="small" color="error" onClick={onDiscard} sx={{ textTransform: 'none' }}>
          Discard
        </Button>
        {canSave ? (
          <Button size="small" variant="contained" onClick={onSave} sx={{ textTransform: 'none' }}>
            Save
          </Button>
        ) : (
          <Button size="small" variant="contained" onClick={onSaveAs} sx={{ textTransform: 'none' }}>
            Save as…
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
