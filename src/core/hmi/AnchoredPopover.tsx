// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AnchoredPopover — Generic 3D-anchored context popover layer (mounted once in App).
 *
 * Renders the active popoverStore request: projects its world anchor to screen every
 * frame (rAF, like TooltipLayer), positions a floating glass panel offset clear of the
 * anchor (so a gizmo at the point stays visible), and renders the registered content
 * component for the request id. The panel is draggable by its top grip — the user
 * displacement is kept in screen space so the panel still tracks the point during orbit.
 * Reusable for any component panel.
 */

import { useEffect, useRef, useSyncExternalStore, createElement } from 'react';
import { Box } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { popoverStore, popoverContentRegistry } from './popover-store';
import { projectPointToScreen } from './tooltip/tooltip-utils';
import { getUIZoom } from './visual-settings-store';
import { useViewer } from '../../hooks/use-viewer';

/** Default screen offset — far enough that the gizmo at the anchor stays fully visible. */
const DEFAULT_OFFSET = { x: 56, y: -24 };

export function AnchoredPopover() {
  const req = useSyncExternalStore(popoverStore.subscribe, popoverStore.getSnapshot);
  const viewer = useViewer();
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  /** User drag displacement in client px (kept in a ref → no per-frame re-render). */
  const dragRef = useRef({ x: 0, y: 0 });

  // Escape dismisses the active popover.
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') popoverStore.hide(req.id); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [req]);

  // Follow the world anchor each frame (+ user drag displacement).
  useEffect(() => {
    if (!req) return;
    dragRef.current = { x: 0, y: 0 }; // new popover starts attached
    let mounted = true;
    const ox = req.offset?.x ?? DEFAULT_OFFSET.x;
    const oy = req.offset?.y ?? DEFAULT_OFFSET.y;
    const tick = () => {
      if (!mounted) return;
      const el = ref.current;
      if (el) {
        const s = projectPointToScreen(req.getWorld(), viewer.camera, viewer.renderer);
        if (s.visible) {
          const zoom = getUIZoom() || 1;
          el.style.left = ((s.x + ox + dragRef.current.x) / zoom) + 'px';
          el.style.top = ((s.y + oy + dragRef.current.y) / zoom) + 'px';
          el.style.visibility = 'visible';
        } else {
          el.style.visibility = 'hidden';
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { mounted = false; cancelAnimationFrame(rafRef.current); };
  }, [req, viewer]);

  if (!req) return null;
  const Content = popoverContentRegistry.get(req.id);
  if (!Content) return null;

  const onGripDown = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const base = { ...dragRef.current };
    const move = (ev: PointerEvent) => { dragRef.current = { x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }; };
    const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  return (
    <Box
      ref={ref}
      data-rv-popover=""
      onPointerDown={(e) => e.stopPropagation()}
      sx={{
        position: 'fixed', left: 0, top: 0, visibility: 'hidden',
        pointerEvents: 'auto', zIndex: 1250,
        bgcolor: 'rgba(18,18,18,0.92)', backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 1,
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        willChange: 'left, top',
      }}
    >
      {/* Drag grip — move the panel aside if it covers something. */}
      <Box
        onPointerDown={onGripDown}
        sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: 16, cursor: 'move', color: 'rgba(255,255,255,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '4px 4px 0 0', '&:hover': { color: 'rgba(255,255,255,0.7)' },
        }}
      >
        <DragIndicatorIcon sx={{ fontSize: 14, transform: 'rotate(90deg)' }} />
      </Box>
      <Box sx={{ px: 1.25, py: 1 }}>{createElement(Content)}</Box>
    </Box>
  );
}
