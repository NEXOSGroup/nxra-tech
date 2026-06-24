// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UIPluginRegistry — Collects UI slot entries from plugins
 * and provides lookup by slot name.
 *
 * Reactive: supports useSyncExternalStore via subscribe/getSnapshot
 * so React re-renders when plugins are registered or unregistered.
 */

import type { UISlot, UISlotEntry } from './rv-ui-plugin';
import { modeContext } from './rv-mode-manager';

export class UIPluginRegistry {
  private entries: UISlotEntry[] = [];
  private _version = 0;
  private _listeners = new Set<() => void>();

  /** Notify all subscribers that the registry changed. */
  private _notify(): void {
    this._version++;
    for (const listener of this._listeners) listener();
  }

  /** Subscribe to registry changes (for useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  /** Snapshot version (for useSyncExternalStore). */
  getSnapshot = (): number => this._version;

  /**
   * Register slot entries from a plugin (slots may be undefined).
   *
   * If the plugin declares `modes` (plan-198), each of its slot entries is
   * auto-gated to those modes' UI contexts: a `shownOnlyInAny: ['mode:<id>', …]`
   * rule is merged into the entry's `visibilityRule` (AND-combined with any
   * existing `shownOnlyIn`/`hiddenIn`), and a `visibilityId` is assigned if
   * absent (HMIShell only applies a rule when `visibilityId` is set). Plugins
   * with no `modes` (shared) are untouched — backward compatible.
   */
  register(plugin: { id?: string; slots?: UISlotEntry[]; modes?: string[] }): void {
    if (!plugin.slots || plugin.slots.length === 0) return;
    const pluginId = (plugin as Record<string, unknown>).id as string | undefined;
    const modeAny = plugin.modes && plugin.modes.length > 0
      ? plugin.modes.map((m) => modeContext(m))
      : null;
    plugin.slots.forEach((entry, i) => {
      entry.pluginId = pluginId ?? entry.pluginId;
      if (modeAny) {
        entry.visibilityRule = { ...entry.visibilityRule, shownOnlyInAny: modeAny };
        if (!entry.visibilityId) {
          entry.visibilityId = `mode-slot:${pluginId ?? 'unknown'}:${entry.slot}:${i}`;
        }
      }
    });
    this.entries.push(...plugin.slots);
    this.entries.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this._notify();
  }

  /** Remove all slot entries belonging to a plugin. */
  unregister(pluginId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.pluginId !== pluginId);
    if (this.entries.length !== before) this._notify();
  }

  /** All components registered for a given slot. */
  getSlotComponents(slot: UISlot): UISlotEntry[] {
    return this.entries.filter((e) => e.slot === slot);
  }

  /** All settings-tab entries. */
  getSettingsTabs(): UISlotEntry[] {
    return this.entries.filter((e) => e.slot === 'settings-tab');
  }
}
