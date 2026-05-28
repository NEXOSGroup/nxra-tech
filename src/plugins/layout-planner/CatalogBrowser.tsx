// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CatalogBrowser — shared presentational shell for a single Library tab.
 *
 * Renders the common chrome every catalog source now uses: an optional header
 * row (icon + count/title + actions), a search field, a collection/category
 * chip row, and a responsive flat grid of cards (supplied as children). The
 * Local Folder, remote URL / GitHub, and (private) Asset Manager tabs all wrap
 * their cards in this component so the library window looks identical
 * regardless of where the assets come from.
 *
 * Purely presentational: it owns no data and no filtering. Callers derive chips
 * with `deriveChips`, filter with `filterByChip`, and pass the already-filtered
 * cards as `children`.
 */

import type { ReactNode } from 'react';
import { Box, Typography, TextField, Chip, Tooltip, IconButton } from '@mui/material';
import { Search } from '@mui/icons-material';
import { RV_SCROLL_CLASS } from '../../core/hmi/shared-sx';
import type { LibraryChip } from './library-chips';

export interface CatalogBrowserAction {
  key: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  /** Optional colour override for the icon (e.g. destructive remove). */
  color?: string;
}

export interface CatalogBrowserProps {
  /** Leading header icon (e.g. folder / cloud). Omit for plain catalogs. */
  headerIcon?: ReactNode;
  /** Header text — typically "<n> assets — <name>". Omit to hide the header. */
  headerText?: ReactNode;
  /** Header action buttons (refresh, remove, …). */
  headerActions?: CatalogBrowserAction[];

  searchText: string;
  onSearchChange: (text: string) => void;
  searchPlaceholder?: string;

  /** Chips to show. When empty, the chip row (incl. the "All" chip) is hidden. */
  chips: LibraryChip[];
  /** Count behind the "All" chip — the unfiltered total for this tab. */
  totalCount: number;
  selectedChip: string | null;
  onSelectChip: (key: string | null) => void;

  /** When true, `emptyContent` is shown instead of the card grid. */
  empty?: boolean;
  emptyContent?: ReactNode;

  /** The already-filtered card elements. */
  children: ReactNode;
}

const SEARCH_INPUT_SX = { fontSize: 11, py: 0.25 } as const;

export function CatalogBrowser({
  headerIcon,
  headerText,
  headerActions,
  searchText,
  onSearchChange,
  searchPlaceholder = 'Search...',
  chips,
  totalCount,
  selectedChip,
  onSelectChip,
  empty,
  emptyContent,
  children,
}: CatalogBrowserProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header */}
      {(headerText !== undefined || headerIcon || (headerActions?.length ?? 0) > 0) && (
        <Box sx={{ px: 1, py: 0.5, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          {headerIcon}
          <Typography
            variant="caption"
            sx={{
              fontSize: 10,
              color: 'text.secondary',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {headerText}
          </Typography>
          {headerActions?.map((a) => (
            <Tooltip key={a.key} title={a.title}>
              <IconButton size="small" onClick={a.onClick} sx={{ p: 0.25, color: a.color }}>
                {a.icon}
              </IconButton>
            </Tooltip>
          ))}
        </Box>
      )}

      {/* Search */}
      <Box sx={{ px: 1, py: 0.5, flexShrink: 0 }}>
        <TextField
          size="small"
          fullWidth
          placeholder={searchPlaceholder}
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          slotProps={{
            input: {
              startAdornment: <Search sx={{ fontSize: 14, color: 'text.secondary', mr: 0.5 }} />,
              sx: SEARCH_INPUT_SX,
            },
          }}
        />
      </Box>

      {/* Chip row */}
      {chips.length > 0 && (
        <Box sx={{ px: 1, py: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, flexShrink: 0 }}>
          <Chip
            label={`All (${totalCount})`}
            size="small"
            variant={selectedChip === null ? 'filled' : 'outlined'}
            color={selectedChip === null ? 'primary' : 'default'}
            onClick={() => onSelectChip(null)}
            sx={{ fontSize: 10, height: 22 }}
          />
          {chips.map((chip) => (
            <Chip
              key={chip.key}
              label={`${chip.label} (${chip.count})`}
              size="small"
              variant={selectedChip === chip.key ? 'filled' : 'outlined'}
              color={selectedChip === chip.key ? 'primary' : 'default'}
              onClick={() => onSelectChip(selectedChip === chip.key ? null : chip.key)}
              sx={{ fontSize: 10, height: 22 }}
            />
          ))}
        </Box>
      )}

      {/* Card grid (or empty content) */}
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, pb: 1 }}>
        {empty ? (
          emptyContent
        ) : (
          <Box
            sx={{
              px: 1,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
              gap: 0.75,
            }}
          >
            {children}
          </Box>
        )}
      </Box>
    </Box>
  );
}
