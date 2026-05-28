// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneRow — Reusable list row for the Scene panel. Used for built-in
 * entries (read-only) and saved "My Scenes" entries (with kebab menu).
 */

import { useCallback, useState, type ReactNode } from 'react';
import {
  IconButton,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
} from '@mui/material';
import { MoreVert } from '@mui/icons-material';

export interface SceneRowMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface SceneRowProps {
  primary: string;
  /** "from <base>" or "5 min ago" — small caption below the primary line. */
  secondary?: string;
  selected: boolean;
  /** When true, render a small filled dot before the name. */
  dirty?: boolean;
  /** Leading icon (defaults to none). */
  icon?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  /** When provided, a kebab opens a per-row menu. */
  menuItems?: SceneRowMenuItem[];
  /** Color of the selected highlight (rgba). */
  selectedBg?: string;
  /** Color of the leading icon when selected. */
  selectedIconColor?: string;
}

export function SceneRow({
  primary,
  secondary,
  selected,
  dirty,
  icon,
  disabled,
  onClick,
  menuItems,
  selectedBg = 'rgba(165,214,167,0.16)',
  selectedIconColor = '#a5d6a7',
}: SceneRowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const openMenu = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget);
  }, []);
  const closeMenu = useCallback(() => setAnchor(null), []);

  return (
    <>
      <ListItemButton
        selected={selected}
        disabled={disabled}
        onClick={onClick}
        sx={{
          py: 0.5,
          borderRadius: 1,
          '&.Mui-selected': { bgcolor: selectedBg },
        }}
      >
        {dirty ? (
          <span
            aria-label="unsaved changes"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              minWidth: 8,
              borderRadius: '50%',
              backgroundColor: '#ff9800',
              marginRight: 8,
            }}
          />
        ) : icon ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              marginRight: 8,
              color: selected ? selectedIconColor : 'rgba(255,255,255,0.6)',
            }}
          >
            {icon}
          </span>
        ) : null}

        <ListItemText
          primary={primary}
          secondary={secondary}
          primaryTypographyProps={{
            fontSize: 13,
            fontWeight: selected ? 600 : 400,
            noWrap: true,
          }}
          secondaryTypographyProps={{
            fontSize: 10,
            color: 'text.secondary',
            noWrap: true,
          }}
        />

        {menuItems && menuItems.length > 0 && (
          <IconButton size="small" sx={{ p: 0.25, ml: 0.5 }} onClick={openMenu}>
            <MoreVert sx={{ fontSize: 14 }} />
          </IconButton>
        )}
      </ListItemButton>

      {menuItems && (
        <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={closeMenu}>
          {menuItems.map((it, i) => (
            <MenuItem
              key={i}
              onClick={() => { closeMenu(); it.onClick(); }}
              sx={it.danger ? { color: '#ef5350' } : undefined}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8 }}>
                {it.icon}
              </span>
              {it.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
