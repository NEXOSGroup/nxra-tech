// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect } from 'react';
import { useViewer } from './use-viewer';

/**
 * Close a left-panel slot the leftPanelManager still holds open when the plugin
 * (or other renderer) that would mount the panel is absent.
 *
 * Plugin-backed panels (machine-control, order-manager, …) are per-model, but the
 * lpm slot persists in localStorage. After a reload or a model switch into a model
 * that doesn't load the plugin, the slot stays "open" with nothing to render — the
 * canvas inset + floating toolbar then reserve an empty strip on the left. Closing
 * the orphaned slot keeps the layout in sync with what is actually rendered.
 *
 * Race-safe: the initial model is awaited before the HMI mounts, so `hasRenderer`
 * is already settled on first render; a `false` value means the panel genuinely
 * has no renderer for this model rather than one still loading.
 *
 * Must be called before any early `return` in the panel (Rules of Hooks).
 *
 * @param slotId      the leftPanelManager panel id this component renders into
 * @param isOpen      whether that slot is the active one
 * @param hasRenderer whether the backing plugin/store is present to render it
 */
export function useDropOrphanedPanelSlot(slotId: string, isOpen: boolean, hasRenderer: boolean): void {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  useEffect(() => {
    if (isOpen && !hasRenderer) lpm.close(slotId);
  }, [slotId, isOpen, hasRenderer, lpm]);
}
