// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drag-types.ts — Drag & Drop MIME type constants and helpers for the Layout Planner.
 */

// Drag & Drop MIME types for Layout Planner
export const DT_CATALOG_ID  = 'text/x-layout-catalog-id'  as const;
export const DT_GLB_URL     = 'text/x-layout-glb-url'     as const;
export const DT_ENTRY_NAME  = 'text/x-layout-entry-name'  as const;
export const DT_CATEGORY    = 'text/x-layout-category'    as const;

/** Set all layout drag payload fields on a DragEvent. */
export function setLayoutDragData(
  dt: DataTransfer,
  entry: { id: string; glbUrl?: string; name: string; category: string },
): void {
  dt.setData(DT_CATALOG_ID, entry.id);
  dt.setData(DT_GLB_URL, entry.glbUrl ?? '');
  dt.setData(DT_ENTRY_NAME, entry.name);
  dt.setData(DT_CATEGORY, entry.category);
}

/** Read layout drag payload from a DragEvent. Returns null if not a layout drag. */
export function getLayoutDragData(dt: DataTransfer): {
  catalogId: string; glbUrl: string; entryName: string; category: string;
} | null {
  const catalogId = dt.getData(DT_CATALOG_ID);
  if (!catalogId) return null;
  return {
    catalogId,
    glbUrl: dt.getData(DT_GLB_URL),
    entryName: dt.getData(DT_ENTRY_NAME),
    category: dt.getData(DT_CATEGORY),
  };
}

/** Suppress the default browser drag ghost image. */
const _emptyImg = new Image();
_emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function suppressDragImage(e: DragEvent | React.DragEvent): void {
  e.dataTransfer?.setDragImage(_emptyImg, 0, 0);
}
