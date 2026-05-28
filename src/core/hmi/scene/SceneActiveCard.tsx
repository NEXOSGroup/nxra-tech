// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneActiveCard — Compact card that summarises the active working scene
 * and surfaces its lifecycle actions (Save / Save as… / Discard / Undo /
 * Redo / Rename / Duplicate / Export).
 *
 * Self-contained: subscribes to SceneStore, renders nothing if no draft is
 * loaded, and owns its own Save-as / Rename name-input dialog. Drop into any
 * panel — Models window, Hierarchy window, etc. — and both will show the
 * same card with identical behaviour.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AutoAwesome,
  ContentCopy,
  Delete,
  DriveFileRenameOutline,
  FileDownload,
  MoreVert,
  Redo,
  Undo,
} from '@mui/icons-material';
import type { SceneStore } from './scene-store';
import { baseLabelOf } from './rv-scene-types';

interface SceneActiveCardProps {
  store: SceneStore;
}

type NameDialogState =
  | { kind: 'saveAs'; name: string }
  | { kind: 'rename'; id: string; name: string }
  | null;

export function SceneActiveCard({ store }: SceneActiveCardProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { saved, draft, isDraft, dirty, busy, canUndo, canRedo, undoLabel, redoLabel } = snap;

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const closeNameDialog = useCallback(() => setNameDialog(null), []);
  const submitNameDialog = useCallback(async () => {
    if (!nameDialog) return;
    const name = nameDialog.name.trim();
    if (!name) return;
    if (nameDialog.kind === 'saveAs') {
      await store.saveAs(name);
    } else {
      store.rename(nameDialog.id, name);
    }
    setNameDialog(null);
  }, [nameDialog, store]);

  const dialogTitle = useMemo(() => {
    if (!nameDialog) return '';
    return nameDialog.kind === 'saveAs' ? 'Save as new scene' : 'Rename scene';
  }, [nameDialog]);

  // Hide entirely when no draft is loaded — no UI noise during boot or
  // between scene switches.
  if (!draft) return null;

  const name = draft.name;
  const baseLabel = baseLabelOf(draft.base);
  const canSave = !isDraft && !!saved && dirty;
  const canSaveAs = true;
  const canDiscard = dirty;
  const canRename = !!saved;
  const canDuplicate = !!saved;
  const canExportJSON = !!saved;

  // Action handlers
  const onSave = () => { void store.save(); };
  const onSaveAs = () => {
    setNameDialog({
      kind: 'saveAs',
      name: isDraft ? draft.name : `${draft.name} (copy)`,
    });
  };
  const onDiscard = () => { void store.discard(); };
  const onUndo = () => { void store.undo(); };
  const onRedo = () => { void store.redo(); };
  const onRename = () => {
    if (!saved) return;
    setNameDialog({ kind: 'rename', id: saved.id, name: saved.name });
  };
  const onDuplicate = () => {
    if (!saved) return;
    store.duplicate(saved.id);
  };
  const onExportJSON = () => {
    if (!saved) return;
    store.exportSceneJSON(saved.id);
  };

  return (
    <>
      <Box
        sx={{
          p: 1.25,
          borderRadius: 1.25,
          bgcolor: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {/* Row 1: dirty dot + name + UNSAVED chip + kebab */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {dirty ? <DirtyDot /> : <Box sx={{ width: 9, minWidth: 9 }} />}
          <Typography
            variant="body2"
            sx={{
              fontSize: 13, fontWeight: 600, flex: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={name}
          >
            {name}
          </Typography>
          {dirty && (
            <Typography
              variant="caption"
              sx={{
                color: '#ff9800', fontSize: 10,
                textTransform: 'uppercase', letterSpacing: 0.5,
              }}
            >
              Unsaved
            </Typography>
          )}
          <Tooltip title="More actions" placement="top">
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              onClick={(e) => setMenuAnchor(e.currentTarget)}
              aria-label="More actions"
            >
              <MoreVert sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Row 2: "from <base>" subtitle */}
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            color: 'text.secondary', fontSize: 10,
            ml: 2.25, mt: 0.25,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          title={baseLabel}
        >
          from {baseLabel}
        </Typography>

        {/* Row 3: primary actions */}
        <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
          <Tooltip
            title={canSave ? 'Save changes' : (saved ? 'No changes to save' : 'Use Save as… to create a new scene')}
            placement="top"
          >
            <span>
              <Button
                variant="contained"
                size="small"
                disabled={!canSave}
                onClick={onSave}
                fullWidth
                sx={{ fontSize: 11, textTransform: 'none', py: 0.4, lineHeight: 1.2 }}
              >
                Save
              </Button>
            </span>
          </Tooltip>
          <Button
            variant="outlined"
            size="small"
            disabled={!canSaveAs}
            onClick={onSaveAs}
            fullWidth
            sx={{ fontSize: 11, textTransform: 'none', py: 0.4, lineHeight: 1.2 }}
          >
            Save as…
          </Button>
        </Box>

        {/* Kebab menu */}
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
          <MenuItem
            disabled={!canUndo || busy}
            onClick={() => { closeMenu(); onUndo(); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}><Undo sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>
              {undoLabel ?? 'Undo'}
            </ListItemText>
          </MenuItem>
          <MenuItem
            disabled={!canRedo || busy}
            onClick={() => { closeMenu(); onRedo(); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}><Redo sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>
              {redoLabel ?? 'Redo'}
            </ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem
            disabled={!canDiscard}
            onClick={() => { closeMenu(); onDiscard(); }}
            sx={{ color: canDiscard ? '#ef5350' : undefined }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}>
              <Delete sx={{ fontSize: 16, color: canDiscard ? '#ef5350' : undefined }} />
            </ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Discard changes</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem
            disabled={!canRename}
            onClick={() => { closeMenu(); onRename(); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}><DriveFileRenameOutline sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Rename</ListItemText>
          </MenuItem>
          <MenuItem
            disabled={!canDuplicate}
            onClick={() => { closeMenu(); onDuplicate(); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}><ContentCopy sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Duplicate</ListItemText>
          </MenuItem>
          <MenuItem
            disabled={!canExportJSON}
            onClick={() => { closeMenu(); onExportJSON(); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}><FileDownload sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Export JSON</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem disabled>
            <ListItemIcon sx={{ minWidth: 28 }}><AutoAwesome sx={{ fontSize: 16 }} /></ListItemIcon>
            <ListItemText
              primary="Export GLB"
              secondary="Coming soon"
              primaryTypographyProps={{ fontSize: 13 }}
              secondaryTypographyProps={{ fontSize: 10 }}
            />
          </MenuItem>
        </Menu>
      </Box>

      {/* Save-as / Rename dialog */}
      <Dialog open={Boolean(nameDialog)} onClose={closeNameDialog} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>{dialogTitle}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Name"
            value={nameDialog?.name ?? ''}
            onChange={(e) => nameDialog && setNameDialog({ ...nameDialog, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitNameDialog(); }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={closeNameDialog} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={submitNameDialog}
            disabled={!(nameDialog?.name.trim())}
            sx={{ textTransform: 'none' }}
          >
            {nameDialog?.kind === 'saveAs' ? 'Save' : 'Rename'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function DirtyDot() {
  return (
    <span
      aria-label="unsaved changes"
      title="Unsaved changes"
      style={{
        display: 'inline-block',
        width: 9, height: 9, minWidth: 9,
        borderRadius: '50%',
        backgroundColor: '#ff9800',
      }}
    />
  );
}
