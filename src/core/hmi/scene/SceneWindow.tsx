// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneWindow — Left-docked panel for managing the active workspace.
 *
 * UI taxonomy (mirrors user-facing terminology, NOT internal types):
 *   - Panel title              "Models"
 *   - Built-in section         "Built-in"   (pre-built base GLBs)
 *   - User-saved section       "My Scenes"  (saved variants on top of a base)
 *   - "Save as…" primary       "Save as…"
 *
 * Internal storage types (RvScene, SceneStore, SceneMeta...) keep their
 * original names — only the surface vocabulary changed. See
 * `doc-persistence.md` §3.0 for the vocabulary contract.
 *
 * The active-scene summary card at the top is rendered by `SceneActiveCard`
 * (shared with the Hierarchy panel). This file owns the model lists, the
 * confirm-on-switch dialog, and the row-level rename / delete dialogs.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  IconButton,
  List,
  Tooltip,
  Typography,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  Add,
  AutoAwesome,
  ContentCopy,
  Delete,
  DriveFileRenameOutline,
  FileDownload,
  FileUpload,
  Folder,
  LibraryAdd,
  Movie,
  PrecisionManufacturing,
} from '@mui/icons-material';
import { LeftPanel } from '../LeftPanel';
import { SCENE_PANEL_WIDTH } from '../layout-constants';
import type { SceneStore } from './scene-store';
import type { PublishedSceneEntry } from './rv-published-scenes';
import { SceneConfirmDialog } from './rv-scene-confirm-dialog';
import { SceneRow } from './rv-scene-row';
import { SceneActiveCard } from './SceneActiveCard';
import { SectionHeader } from '../shared-components';

interface SceneWindowProps {
  store: SceneStore;
  onClose: () => void;
}

/** Local state for the "Save as… (after switch)" dialog and the per-row
 *  Rename dialog. The active-card SaveAs/Rename is owned by
 *  `SceneActiveCard`, so this state never overlaps with that. */
type NameDialogState =
  | { kind: 'saveAs'; name: string; thenSwitch?: () => Promise<void> }
  | { kind: 'rename'; id: string; name: string }
  | null;

export function SceneWindow({ store, onClose }: SceneWindowProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { saved, draft, isDraft, dirty, scenes, builtins, published, activePublishedName, busy } = snap;

  const currentName = draft?.name ?? '(no model)';
  const canSaveExisting = !isDraft && !!saved;

  // ─── Confirm-on-switch ─────────────────────────────────────────────
  const [pendingSwitch, setPendingSwitch] = useState<(() => Promise<void>) | null>(null);
  const tryDoSwitch = useCallback((action: () => Promise<void>) => {
    if (dirty) setPendingSwitch(() => action);
    else void action();
  }, [dirty]);

  // ─── Name dialog (row Rename, post-confirm Save-as) ────────────────
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const closeNameDialog = useCallback(() => setNameDialog(null), []);
  const submitNameDialog = useCallback(async () => {
    if (!nameDialog) return;
    const name = nameDialog.name.trim();
    if (!name) return;
    if (nameDialog.kind === 'saveAs') {
      await store.saveAs(name);
      const next = nameDialog.thenSwitch;
      setNameDialog(null);
      if (next) await next();
    } else {
      store.rename(nameDialog.id, name);
      setNameDialog(null);
    }
  }, [nameDialog, store]);

  // ─── Confirm dialog actions ────────────────────────────────────────
  const onConfirmSave = useCallback(async () => {
    await store.save();
    const next = pendingSwitch;
    setPendingSwitch(null);
    if (next) await next();
  }, [store, pendingSwitch]);
  const onConfirmSaveAs = useCallback(() => {
    if (!draft) return;
    const next = pendingSwitch;
    setPendingSwitch(null);
    setNameDialog({
      kind: 'saveAs',
      name: draft.name,
      thenSwitch: next ?? undefined,
    });
  }, [draft, pendingSwitch]);
  const onConfirmDiscard = useCallback(async () => {
    const next = pendingSwitch;
    setPendingSwitch(null);
    await store.discard();
    if (next) await next();
  }, [store, pendingSwitch]);
  const onConfirmCancel = useCallback(() => setPendingSwitch(null), []);

  // ─── Row clicks ────────────────────────────────────────────────────
  const onClickBuiltin = useCallback((url: string, label: string) => {
    tryDoSwitch(() => store.openBuiltin(url, label));
  }, [tryDoSwitch, store]);
  const onClickScene = useCallback((id: string) => {
    tryDoSwitch(() => store.openScene(id));
  }, [tryDoSwitch, store]);
  const onClickNewEmpty = useCallback(() => {
    tryDoSwitch(() => store.newEmpty());
  }, [tryDoSwitch, store]);

  // ─── Example (published) clicks ────────────────────────────────────
  // Surface failures (offline, 404, stale index.json, malformed JSON, full
  // storage) instead of a silent no-op — mirrors onImportJSON's alert pattern.
  const onOpenExample = useCallback((entry: PublishedSceneEntry) => {
    tryDoSwitch(async () => {
      try {
        await store.openPublishedExample(entry);
      } catch (e) {
        alert(`Failed to open example: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }, [tryDoSwitch, store]);
  const onAddExample = useCallback((entry: PublishedSceneEntry) => {
    tryDoSwitch(async () => {
      try {
        await store.addPublishedToMyScenes(entry);
      } catch (e) {
        alert(`Failed to add example to My Scenes: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }, [tryDoSwitch, store]);

  // ─── Import JSON ───────────────────────────────────────────────────
  const onImportJSON = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        await store.importSceneJSON(f);
      } catch (e) {
        alert(`Failed to import scene: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    input.click();
  }, [store]);

  // ─── Selected ids for highlight ────────────────────────────────────
  const activeBuiltinUrl =
    draft?.base.kind === 'builtin' ? draft.base.url : null;
  const activeSceneId = saved?.id ?? null;

  const dialogTitle = useMemo(() => {
    if (!nameDialog) return '';
    return nameDialog.kind === 'saveAs' ? 'Save as new scene' : 'Rename scene';
  }, [nameDialog]);

  return (
    <LeftPanel
      title="Models"
      onClose={onClose}
      width={SCENE_PANEL_WIDTH}
    >
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: 2 }}>

        {/* ─── Active card (shared with Hierarchy panel) ────────── */}
        <SceneActiveCard store={store} />

        {/* ─── Built-in ────────────────────────────────────────── */}
        <Box>
          <SectionHeader>Built-in</SectionHeader>
          {builtins.length === 0 ? (
            <EmptyHint>No built-in models available.</EmptyHint>
          ) : (
            <List dense disablePadding sx={{ mt: 0.5 }}>
              {builtins.map(b => {
                const selected = b.url === activeBuiltinUrl;
                return (
                  <SceneRow
                    key={b.url}
                    primary={b.label}
                    selected={selected}
                    icon={<Movie sx={{ fontSize: 14 }} />}
                    selectedBg="rgba(79,195,247,0.16)"
                    selectedIconColor="#4fc3f7"
                    disabled={busy}
                    onClick={() => onClickBuiltin(b.url, b.label)}
                  />
                );
              })}
            </List>
          )}
        </Box>

        {/* ─── Examples (read-only published demos) ─────────────── */}
        {/* Intentionally hidden when empty: a curated section with nothing to show
            adds noise for ordinary visitors (unlike Built-in, where empty signals
            a real problem, or My Scenes, which the user populates). */}
        {published.length > 0 && (
          <Box>
            <SectionHeader>Examples</SectionHeader>
            <List dense disablePadding sx={{ mt: 0.5 }}>
              {published.map(p => (
                <SceneRow
                  key={p.file}
                  primary={p.label}
                  selected={p.urlName === activePublishedName}
                  icon={<AutoAwesome sx={{ fontSize: 14 }} />}
                  selectedBg="rgba(186,104,200,0.16)"
                  selectedIconColor="#ba68c8"
                  disabled={busy}
                  onClick={() => onOpenExample(p)}
                  menuItems={[
                    {
                      label: 'Add to My Scenes',
                      icon: <LibraryAdd sx={{ fontSize: 16 }} />,
                      onClick: () => onAddExample(p),
                    },
                  ]}
                />
              ))}
            </List>
          </Box>
        )}

        {/* ─── My Scenes ──────────────────────────────────────── */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            <Box sx={{ flex: 1 }}>
              <SectionHeader>My Scenes</SectionHeader>
            </Box>
            <Tooltip title="New empty scene (30 m floor)" placement="top">
              <span>
                <IconButton
                  size="small"
                  onClick={onClickNewEmpty}
                  disabled={busy}
                  sx={{ p: 0.25 }}
                  aria-label="New empty scene"
                >
                  <Add sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Import scene (.json)" placement="top">
              <span>
                <IconButton
                  size="small"
                  onClick={onImportJSON}
                  disabled={busy}
                  sx={{ p: 0.25 }}
                  aria-label="Import scene JSON"
                >
                  <FileUpload sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          {scenes.length === 0 ? (
            <EmptyHint>No scenes yet. Open a built-in model or start an empty scene.</EmptyHint>
          ) : (
            <List dense disablePadding sx={{ mt: 0.5 }}>
              {scenes.map(s => {
                const selected = s.id === activeSceneId;
                const subtitle = `${timeAgo(s.modifiedAt)} · from ${s.baseLabel}`;
                return (
                  <SceneRow
                    key={s.id}
                    primary={s.name}
                    secondary={subtitle}
                    selected={selected}
                    dirty={selected && dirty}
                    icon={s.baseKind === 'builtin'
                      ? <Folder sx={{ fontSize: 14 }} />
                      : <PrecisionManufacturing sx={{ fontSize: 14 }} />}
                    disabled={busy}
                    onClick={() => onClickScene(s.id)}
                    menuItems={[
                      {
                        label: 'Rename',
                        icon: <DriveFileRenameOutline sx={{ fontSize: 16 }} />,
                        onClick: () => setNameDialog({ kind: 'rename', id: s.id, name: s.name }),
                      },
                      {
                        label: 'Duplicate',
                        icon: <ContentCopy sx={{ fontSize: 16 }} />,
                        onClick: () => store.duplicate(s.id),
                      },
                      {
                        label: 'Export JSON',
                        icon: <FileDownload sx={{ fontSize: 16 }} />,
                        onClick: () => store.exportSceneJSON(s.id),
                      },
                      {
                        label: 'Delete',
                        icon: <Delete sx={{ fontSize: 16 }} />,
                        danger: true,
                        onClick: () => {
                          if (confirm(`Delete scene "${s.name}"?`)) {
                            void store.delete(s.id);
                          }
                        },
                      },
                    ]}
                  />
                );
              })}
            </List>
          )}
        </Box>
      </Box>

      {/* ─── Modals ─────────────────────────────────────────────── */}
      <SceneConfirmDialog
        open={pendingSwitch !== null}
        sceneName={currentName}
        canSave={canSaveExisting}
        onSave={onConfirmSave}
        onSaveAs={onConfirmSaveAs}
        onDiscard={onConfirmDiscard}
        onCancel={onConfirmCancel}
      />

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
          <Button size="small" onClick={closeNameDialog} sx={{ textTransform: 'none' }}>Cancel</Button>
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
    </LeftPanel>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontStyle: 'italic', fontSize: 11 }}
    >
      {children}
    </Typography>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} d ago`;
  return new Date(iso).toLocaleDateString();
}
