// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LibrarySelector — the Library window's source switcher.
 *
 * Replaces the old scrollable tab strip with a single full-width dropdown:
 * the trigger shows the active library (full name, type icon), and the menu
 * lists every loaded library with a per-row remove (and, for local folders,
 * refresh) action plus an "Add library…" entry. Scales to any number of
 * libraries without truncation or scroll arrows, and makes removal a visible,
 * one-click action instead of a hidden right-click menu.
 */

import { useState, type ReactNode } from 'react';
import {
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Tooltip,
  Typography,
  CircularProgress,
} from '@mui/material';
import {
  ArrowDropDown,
  Check,
  Delete,
  Refresh,
  Add,
  Cloud,
  GitHub,
  FolderOpen,
  Link as LinkIcon,
  CollectionsBookmark,
  MoreVert,
} from '@mui/icons-material';

export type LibraryKind = 'url' | 'github' | 'local' | 'cloud';

export interface LibraryItem {
  id: string;
  label: string;
  kind: LibraryKind;
  /** Connection state for cloud (Asset Manager) libraries. */
  cloudStatus?: 'connected' | 'connecting' | 'error';
  /** Local folder whose browser permission lapsed — selecting it re-grants. */
  needsPermission?: boolean;
  /** Catalog failed to load (non-permission error). */
  error?: boolean;
}

export interface LibrarySelectorProps {
  items: LibraryItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  /** Refresh a local-folder library (re-scan files). */
  onRefresh?: (id: string) => void;
  onAdd: () => void;
  /** Compact mode (mobile): collapse the inline refresh/remove/add buttons into
   *  a single "⋮" overflow menu and tighten padding, so the header row stays
   *  small. Default false keeps the desktop inline-actions layout. */
  compact?: boolean;
}

function kindIcon(kind: LibraryKind, status: LibraryItem['cloudStatus'], error?: boolean): ReactNode {
  const sx = { fontSize: 16 } as const;
  switch (kind) {
    case 'github': return <GitHub sx={sx} />;
    case 'local': return <FolderOpen sx={{ ...sx, color: '#66bb6a' }} />;
    case 'cloud': {
      const color = status === 'connected' ? '#66bb6a' : status === 'connecting' ? '#ffb74d' : '#ef5350';
      return <Cloud sx={{ ...sx, color }} />;
    }
    default: return <LinkIcon sx={{ ...sx, color: error ? '#ef5350' : undefined }} />;
  }
}

export function LibrarySelector({ items, activeId, onSelect, onRemove, onRefresh, onAdd, compact = false }: LibrarySelectorProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  // Compact-mode overflow ("⋮") menu anchor — separate from the library dropdown.
  const [actionAnchor, setActionAnchor] = useState<HTMLElement | null>(null);
  const closeActions = () => setActionAnchor(null);

  const active = items.find(i => i.id === activeId) ?? null;
  const triggerLabel = active?.label ?? (items.length === 0 ? 'Add a library…' : 'Select library');

  const handleTriggerClick = (e: React.MouseEvent<HTMLElement>) => {
    if (items.length === 0) { onAdd(); return; } // nothing to pick — go straight to Add
    setAnchor(e.currentTarget);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: compact ? 0.5 : 1, py: compact ? 0 : 0.75, flexShrink: 0 }}>
      <Button
        onClick={handleTriggerClick}
        variant="outlined"
        size="small"
        fullWidth
        startIcon={active ? kindIcon(active.kind, active.cloudStatus, active.error) : <CollectionsBookmark sx={{ fontSize: 16 }} />}
        endIcon={items.length > 0 ? <ArrowDropDown /> : undefined}
        sx={{
          justifyContent: 'space-between',
          textTransform: 'none',
          fontSize: 12,
          color: 'text.primary',
          borderColor: 'rgba(255,255,255,0.15)',
          '& .MuiButton-startIcon': { mr: 0.75 },
          '&:hover': { borderColor: 'rgba(255,255,255,0.3)' },
          ...(compact && {
            py: 0,
            minHeight: 24,
            lineHeight: 1.2,
            // Shrink the (otherwise 24px) chevron + start icon so they don't
            // inflate the row height on mobile.
            '& .MuiSvgIcon-root': { fontSize: 16 },
          }),
        }}
      >
        <Box component="span" sx={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel}
        </Box>
      </Button>

      {/* Actions for the ACTIVE library. Desktop: inline refresh/remove/add.
          Compact (mobile): a single "⋮" overflow menu to keep the row small. */}
      {compact ? (
        <>
          <IconButton size="small" onClick={(e) => setActionAnchor(e.currentTarget)} sx={{ p: 0.25, flexShrink: 0 }} aria-label="Library actions">
            <MoreVert sx={{ fontSize: 18 }} />
          </IconButton>
          <Menu anchorEl={actionAnchor} open={!!actionAnchor} onClose={closeActions}>
            {active?.kind === 'local' && onRefresh && (
              <MenuItem onClick={() => { onRefresh(active.id); closeActions(); }} sx={{ fontSize: 12 }}>
                <ListItemIcon sx={{ minWidth: 26 }}><Refresh sx={{ fontSize: 16 }} /></ListItemIcon>
                Refresh folder
              </MenuItem>
            )}
            <MenuItem disabled={!active} onClick={() => { if (active) onRemove(active.id); closeActions(); }} sx={{ fontSize: 12 }}>
              <ListItemIcon sx={{ minWidth: 26 }}><Delete sx={{ fontSize: 16 }} /></ListItemIcon>
              Remove library
            </MenuItem>
            <MenuItem onClick={() => { onAdd(); closeActions(); }} sx={{ fontSize: 12 }}>
              <ListItemIcon sx={{ minWidth: 26 }}><Add sx={{ fontSize: 16 }} /></ListItemIcon>
              Add library…
            </MenuItem>
          </Menu>
        </>
      ) : (
        <>
          {active?.kind === 'local' && onRefresh && (
            <Tooltip title="Refresh folder">
              <IconButton size="small" onClick={() => onRefresh(active.id)} sx={{ p: 0.5 }} aria-label="Refresh folder">
                <Refresh sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={active ? 'Remove this library' : 'No library to remove'}>
            {/* span wrapper so the tooltip works while the button is disabled */}
            <span>
              <IconButton
                size="small"
                disabled={!active}
                onClick={() => { if (active) onRemove(active.id); }}
                sx={{ p: 0.5, color: active ? 'text.secondary' : 'text.disabled', '&:hover': { color: '#ef5350' } }}
                aria-label="Remove library"
              >
                <Delete sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Add library">
            <IconButton size="small" onClick={onAdd} sx={{ p: 0.5 }} aria-label="Add library">
              <Add sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </>
      )}

      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 260, maxWidth: 360 } } }}
      >
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <MenuItem
              key={item.id}
              selected={isActive}
              onClick={() => { onSelect(item.id); close(); }}
              sx={{ fontSize: 12, py: 0.5, pr: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 26 }}>
                {isActive ? <Check sx={{ fontSize: 16, color: 'primary.main' }} /> : kindIcon(item.kind, item.cloudStatus, item.error)}
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                secondary={item.needsPermission ? 'Permission needed — click to re-grant' : item.error ? 'Failed to load' : undefined}
                slotProps={{
                  primary: { sx: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  secondary: { sx: { fontSize: 10, color: item.error ? '#ef5350' : 'text.disabled' } },
                }}
              />
              {item.kind === 'cloud' && item.cloudStatus === 'connecting' && (
                <CircularProgress size={12} sx={{ ml: 0.5 }} />
              )}
            </MenuItem>
          );
        })}

        {items.length > 0 && <Divider />}

        <MenuItem onClick={() => { onAdd(); close(); }} sx={{ fontSize: 12, py: 0.5 }}>
          <ListItemIcon sx={{ minWidth: 26 }}>
            <Add sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <Typography sx={{ fontSize: 12 }}>Add library…</Typography>
        </MenuItem>
      </Menu>
    </Box>
  );
}
