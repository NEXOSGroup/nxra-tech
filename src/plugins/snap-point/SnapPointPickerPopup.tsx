// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapPointPickerPopup — React portal popup that lists library assets
 * compatible with the currently hovered snap point.
 *
 * Opens on click (driven by SnapPointController), closes on ESC, outside
 * click, or after a successful placement.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Box, Paper, Typography, CircularProgress, ButtonBase } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';
import type { LayoutPlannerPlugin } from '../layout-planner';
import type { SnapPoint } from '../../core/engine/rv-snap-point-registry';
import { useSnapHoverState, snapHoverStore } from './snap-hover-store';
import { findCompatibleLibraryAssets } from './library-snap-index';
import { oppositeDirection } from './snap-name-parser';
import type { SnapPointPlugin } from './index';
import { t } from './strings';

interface CompatibleEntry {
  entry: LibraryCatalogEntry;
  ownSnapName: string;
}

export function SnapPointPickerPopup({ viewer }: UISlotProps): ReactElement | null {
  const hover = useSnapHoverState();
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Library entries (subscribed)
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const layoutStore = planner?.store;
  const layoutSnap = useSyncExternalStore(
    layoutStore?.subscribe ?? (() => () => {}),
    layoutStore?.getSnapshot ?? (() => null),
  );
  const allEntries = useMemo<LibraryCatalogEntry[]>(() => {
    if (!layoutSnap) return [];
    const out: LibraryCatalogEntry[] = [];
    for (const cat of layoutSnap.catalogs.values()) {
      out.push(...cat.entries);
    }
    return out;
  }, [layoutSnap]);

  const [items, setItems] = useState<CompatibleEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isPlacing, setIsPlacing] = useState(false);

  // Load compatible items whenever the picker opens
  useEffect(() => {
    if (!hover.pickerOpen || !hover.pickerAnchor) {
      setItems([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');

    const target = hover.pickerAnchor;
    // Direction is no longer a hard filter — pass it as a preference so the
    // picker shows the natural same-axis-opposite option first when an asset
    // exposes both, but cross-axis options remain listed. Flow is a HARD
    // filter (in↔out, bidi↔any; rejects in↔in / out↔out).
    const preferred = oppositeDirection(target.dir);
    findCompatibleLibraryAssets(allEntries, target.typeId, preferred, target.flow)
      .then((found) => {
        if (cancelled) return;
        setItems(found);
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(String(e));
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [hover.pickerOpen, hover.pickerAnchor, allEntries]);

  // Outside-click close
  useEffect(() => {
    if (!hover.pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popupRef.current && !popupRef.current.contains(t)) {
        snapHoverStore.closePicker();
      }
    };
    // Defer one tick so the opening click itself does not close us
    const tid = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('mousedown', onDown);
    };
  }, [hover.pickerOpen]);

  if (!hover.pickerOpen || !hover.pickerAnchor || !hover.pickerScreenPos) {
    return null;
  }

  const onPickEntry = async (item: CompatibleEntry): Promise<void> => {
    if (isPlacing) return;
    if (!planner) return;
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    if (!snapPlugin) return;
    const registry = snapPlugin.getRegistry();
    if (!registry) return;

    const target = hover.pickerAnchor;
    if (!target) return;
    if (target.occupied) {
      setErrorMsg(t('error.occupied'));
      return;
    }

    setIsPlacing(true);
    try {
      // Delegate the actual GLB clone + snap-aligned placement to the planner.
      // The planner exposes placeAtSnap via a thin shim added in Phase 6.
      const plannerWithSnap = planner as LayoutPlannerPlugin & {
        placeAtSnap?: (entry: LibraryCatalogEntry, target: SnapPoint, ownSnapName: string) => Promise<string | null>;
      };
      if (typeof plannerWithSnap.placeAtSnap === 'function') {
        const id = await plannerWithSnap.placeAtSnap(item.entry, target, item.ownSnapName);
        if (id) {
          snapHoverStore.closePicker();
        } else {
          setErrorMsg('Placement rejected');
        }
      } else {
        setErrorMsg('Snap placement not wired in planner');
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setIsPlacing(false);
    }
  };

  const left = hover.pickerScreenPos.x + 12;
  const top = hover.pickerScreenPos.y + 12;

  return (
    <Paper
      ref={popupRef}
      elevation={6}
      data-testid="snap-picker-popup"
      sx={{
        position: 'fixed',
        left,
        top,
        zIndex: 2500,
        minWidth: 280,
        maxWidth: 360,
        maxHeight: 360,
        overflow: 'auto',
        p: 1.25,
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{ pb: 0.5, mb: 0.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Typography variant="subtitle2">
          {t('picker.title')} <strong>{hover.pickerAnchor.typeId}</strong>
        </Typography>
      </Box>

      {status === 'loading' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="body2">{t('picker.loading')}</Typography>
        </Box>
      )}

      {status === 'error' && (
        <Typography variant="body2" color="error">{errorMsg || 'Error'}</Typography>
      )}

      {status === 'ready' && items.length === 0 && (
        <Typography variant="body2" sx={{ py: 1, opacity: 0.7 }}>
          {t('picker.empty')}
        </Typography>
      )}

      {status === 'ready' && items.map((item) => (
        <ButtonBase
          key={item.entry.id}
          data-testid="library-item"
          disabled={isPlacing}
          onClick={() => { void onPickEntry(item); }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            width: '100%',
            justifyContent: 'flex-start',
            p: 0.75,
            borderRadius: 1,
            '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
          }}
        >
          {item.entry.thumbnailUrl ? (
            <img
              src={item.entry.thumbnailUrl}
              width={36}
              height={36}
              alt=""
              style={{ objectFit: 'cover', borderRadius: 4 }}
            />
          ) : (
            <Box
              sx={{
                width: 36, height: 36, borderRadius: 1,
                backgroundColor: 'rgba(255,255,255,0.08)',
              }}
            />
          )}
          <Box sx={{ textAlign: 'left' }}>
            <Typography variant="body2">{item.entry.name}</Typography>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>
              {item.entry.category}
            </Typography>
          </Box>
        </ButtonBase>
      ))}

      {errorMsg && status !== 'error' && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
          {errorMsg}
        </Typography>
      )}

      <Box sx={{ mt: 1, opacity: 0.5 }}>
        <Typography variant="caption">{t('picker.cancel')}</Typography>
      </Box>
    </Paper>
  );
}
