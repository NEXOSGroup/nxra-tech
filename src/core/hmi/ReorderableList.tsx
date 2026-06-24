// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ReorderableList.tsx — Reusable ordered-list UI with up/down + drag reordering,
 * row selection, and optional remove. Presentational only: it owns no data,
 * it just renders `items` and calls the handlers. Use it anywhere an ordered
 * list needs in-place reordering (IK path targets, LogicStep children, …).
 *
 * Drag-to-reorder (HTML5 DnD) is enabled automatically when `onReorder` is set.
 */

import { useRef, useState } from 'react';
import { Box, IconButton, Typography, Tooltip } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CloseIcon from '@mui/icons-material/Close';

export interface ReorderableListItem {
  /** Stable unique id (used for selection match + React key). */
  id: string;
  /** Primary label. */
  label: string;
  /** Optional secondary label shown right-aligned, dimmed. */
  sublabel?: string;
}

export interface ReorderableListProps {
  items: ReorderableListItem[];
  /** Move item from index `from` to index `to`. */
  onReorder?: (from: number, to: number) => void;
  /** Row clicked (not on a button). */
  onSelect?: (index: number, item: ReorderableListItem) => void;
  /** Remove button clicked. Omit to hide the remove button. */
  onRemove?: (index: number, item: ReorderableListItem) => void;
  /** Highlight the row whose item.id matches. */
  selectedId?: string | null;
  /** Text shown when the list is empty. */
  emptyText?: string;
  /** Show 1-based index prefix. Default true. */
  showIndex?: boolean;
}

export function ReorderableList({
  items, onReorder, onSelect, onRemove, selectedId, emptyText = '(empty)', showIndex = true,
}: ReorderableListProps) {
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const canDrag = !!onReorder;

  if (items.length === 0) {
    return (
      <Typography sx={{ fontSize: 11, color: 'text.disabled', px: 1, py: 0.5 }}>{emptyText}</Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, px: 0.5, py: 0.5 }}>
      {items.map((item, i) => {
        const selected = selectedId != null && item.id === selectedId;
        return (
          <Box
            key={item.id + '#' + i}
            draggable={canDrag}
            onClick={() => onSelect?.(i, item)}
            onDragStart={canDrag ? (e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; } : undefined}
            onDragOver={canDrag ? (e) => { e.preventDefault(); if (dragOver !== i) setDragOver(i); } : undefined}
            onDragLeave={canDrag ? () => { if (dragOver === i) setDragOver(null); } : undefined}
            onDrop={canDrag ? (e) => {
              e.preventDefault();
              const from = dragFrom.current;
              if (from != null && from !== i) onReorder!(from, i);
              dragFrom.current = null; setDragOver(null);
            } : undefined}
            onDragEnd={canDrag ? () => { dragFrom.current = null; setDragOver(null); } : undefined}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5,
              px: 0.75, py: 0.25, borderRadius: 0.5,
              cursor: onSelect ? 'pointer' : (canDrag ? 'grab' : 'default'),
              bgcolor: selected ? 'rgba(79,195,247,0.18)' : 'transparent',
              border: selected ? '1px solid rgba(79,195,247,0.5)' : '1px solid transparent',
              borderTop: dragOver === i ? '2px solid rgba(79,195,247,0.9)' : undefined,
              '&:hover': { bgcolor: selected ? 'rgba(79,195,247,0.22)' : 'rgba(255,255,255,0.06)' },
            }}
          >
            {showIndex && (
              <Typography sx={{ fontSize: 10, color: 'text.disabled', minWidth: 16, textAlign: 'right' }}>{i + 1}</Typography>
            )}
            <Typography sx={{ fontSize: 11, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </Typography>
            {item.sublabel && (
              <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}>{item.sublabel}</Typography>
            )}
            <Tooltip title="Move up" placement="top">
              <span>
                <IconButton
                  size="small" disabled={i === 0}
                  onClick={(e) => { e.stopPropagation(); onReorder?.(i, i - 1); }}
                  sx={{ p: 0.25 }}
                >
                  <ArrowUpwardIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down" placement="top">
              <span>
                <IconButton
                  size="small" disabled={i === items.length - 1}
                  onClick={(e) => { e.stopPropagation(); onReorder?.(i, i + 1); }}
                  sx={{ p: 0.25 }}
                >
                  <ArrowDownwardIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </span>
            </Tooltip>
            {onRemove && (
              <Tooltip title="Remove" placement="top">
                <IconButton
                  size="small"
                  onClick={(e) => { e.stopPropagation(); onRemove(i, item); }}
                  sx={{ p: 0.25, color: 'rgba(255,120,120,0.8)' }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
