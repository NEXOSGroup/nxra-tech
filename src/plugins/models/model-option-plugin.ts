// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * model-option-plugin.ts — Generic "model option" mechanism, reusable by any model.
 *
 * A model option is a named variant of the SAME GLB geometry (e.g. a supplier swap).
 * Two co-operating parts:
 *
 *   1. Selector expansion (main.ts): eager-globs every `models/<name>/model-options.ts`
 *      and adds one selector entry per option, reusing the base GLB url plus an
 *      `?option=<id>` marker. No duplicate GLB, no build step.
 *
 *   2. ModelOptionPlugin (this file): a model's index.ts registers it with an `apply`
 *      callback. On load the plugin reads the active `?option=` marker and runs that
 *      callback, which issues commands (below) to manipulate rv_extras on the scene.
 *
 * Command-based by design: each model's index.ts spells out, imperatively, what an
 * option does — readable next to the model it belongs to. The commands here are the
 * generic primitives; add more as needed.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';

/** A selectable model option (e.g. a supplier variant). Pure selector metadata. */
export interface ModelOptionDef {
  /** URL marker + identity, e.g. 'bosch'. */
  id: string;
  /** Display label appended to the base model name in the selector, e.g. 'Bosch'. */
  label: string;
}

/** Read the active option id from a model URL's `?option=` query, or null. */
export function optionIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const qi = url.indexOf('?');
  if (qi < 0) return null;
  return new URLSearchParams(url.substring(qi + 1)).get('option');
}

// ─── Commands (generic rv_extras manipulation) ─────────────────────────────
// These mutate the loaded scene in place. They run after construction, so they
// reflect immediately in the property inspector and any consumer that reads
// `userData.realvirtual` / derived state live (tooltips, AAS panel, …). They do
// NOT retroactively reconfigure already-constructed behavioural components
// (e.g. a running Drive) — use a GLB/overlay for that.

/**
 * Set any rv_extras component field on a node, e.g.
 * `setComponentField(viewer, path, 'AASLink', 'Description', 'SEW gearmotor')`.
 * Creates the component bucket if missing. The property inspector reads this live.
 */
export function setComponentField(
  viewer: RVViewer,
  nodePath: string,
  component: string,
  field: string,
  value: unknown,
): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const ud = node.userData as Record<string, unknown>;
  let rv = ud.realvirtual as Record<string, Record<string, unknown>> | undefined;
  if (!rv) { rv = {}; ud.realvirtual = rv; }
  if (!rv[component]) rv[component] = {};
  rv[component][field] = value;
}

/**
 * Re-point every node whose AAS link currently equals `fromAasId` to a new supplier
 * AAS. Updates both the derived `_rvAasLink` (tooltip / AAS panel) and the raw
 * `AASLink` rv_extras component (property inspector). Value-matched, so it hits all
 * matching nodes regardless of path.
 */
export function remapAasLink(
  viewer: RVViewer,
  fromAasId: string,
  toAasId: string,
  description: string,
): void {
  viewer.scene.traverse((node) => {
    const link = node.userData?._rvAasLink as { aasId: string; description: string } | undefined;
    if (link?.aasId !== fromAasId) return;
    link.aasId = toAasId;
    link.description = description;
    const comp = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.AASLink;
    if (comp) { comp.AASId = toAasId; comp.Description = description; }
  });
}

// ─── Plugin ────────────────────────────────────────────────────────────────

/**
 * Runs a model's option `apply` callback for the active `?option=` marker (read from
 * the loaded model URL, falling back to the page URL for manual deep links).
 *
 * Register FIRST among a model's plugins when an option swaps AAS ids, so the swap
 * lands before AasLinkPlugin pre-parses the AASX.
 */
export class ModelOptionPlugin implements RVViewerPlugin {
  readonly id = 'model-option';

  constructor(private readonly apply: (viewer: RVViewer, optionId: string) => void) {}

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const id = optionIdFromUrl(viewer.pendingModelUrl)
      ?? new URLSearchParams(window.location.search).get('option');
    if (id) this.apply(viewer, id);
  }
}
