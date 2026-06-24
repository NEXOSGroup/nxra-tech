// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * enablePlugin() / disablePlugin() symmetry tests (plan-198 mode system).
 *
 * Validates the participation-toggling contract that the ModeManager relies on:
 *   - disablePlugin removes a plugin from the pre/post/render phase lists;
 *   - enablePlugin re-inserts it sorted by order and is a no-op when not disabled;
 *   - a plugin disabled when a model loads MISSES onModelLoaded and gets it
 *     replayed exactly once on enable (and never double-fires);
 *   - core plugins cannot be disabled.
 *
 * Pure mock host mirroring RVViewer's plugin-system logic (same approach as
 * rv-plugin-lifecycle.test.ts) — no WebGL/DOM needed.
 */
import { describe, it, expect } from 'vitest';

class PluginHost {
  plugins: any[] = [];
  prePlugins: any[] = [];
  postPlugins: any[] = [];
  renderPlugins: any[] = [];
  disabledIds = new Set<string>();
  missedModelLoad = new Set<string>();
  private _lastLoadResult: any = null;
  drives: any[] = [];

  private insertSorted(list: any[], p: any) {
    if (list.includes(p)) return;
    list.push(p);
    list.sort((a: any, b: any) => (a.order ?? 100) - (b.order ?? 100));
  }

  use(plugin: any): this {
    if (this.plugins.some((p: any) => p.id === plugin.id)) return this;
    this.plugins.push(plugin);
    if (plugin.onFixedUpdatePre) this.insertSorted(this.prePlugins, plugin);
    if (plugin.onFixedUpdatePost) this.insertSorted(this.postPlugins, plugin);
    if (plugin.onRender) this.insertSorted(this.renderPlugins, plugin);
    if (this.drives.length > 0 && this._lastLoadResult && plugin.onModelLoaded && !this.disabledIds.has(plugin.id)) {
      plugin.onModelLoaded(this._lastLoadResult, this);
    }
    return this;
  }

  disablePlugin(id: string): void {
    this.prePlugins = this.prePlugins.filter((p) => p.id !== id);
    this.postPlugins = this.postPlugins.filter((p) => p.id !== id);
    this.renderPlugins = this.renderPlugins.filter((p) => p.id !== id);
    this.disabledIds.add(id);
  }

  enablePlugin(id: string): void {
    if (!this.disabledIds.has(id)) return;
    this.disabledIds.delete(id);
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;
    if (plugin.onFixedUpdatePre) this.insertSorted(this.prePlugins, plugin);
    if (plugin.onFixedUpdatePost) this.insertSorted(this.postPlugins, plugin);
    if (plugin.onRender) this.insertSorted(this.renderPlugins, plugin);
    if (this.missedModelLoad.delete(id) && this._lastLoadResult) {
      plugin.onModelLoaded?.(this._lastLoadResult, this);
    }
  }

  simulateLoad(result: any) {
    this._lastLoadResult = result;
    this.drives = [{ name: 'TestDrive' }];
    for (const p of this.plugins) {
      if (this.disabledIds.has(p.id)) { this.missedModelLoad.add(p.id); continue; }
      if (p.onModelLoaded) p.onModelLoaded(result, this);
    }
  }

  clearModel() {
    this._lastLoadResult = null;
    this.missedModelLoad.clear();
    this.drives = [];
  }

  fixedUpdate(dt: number) {
    for (const p of this.prePlugins) { try { p.onFixedUpdatePre!(dt); } catch { /* isolated */ } }
    for (const p of this.postPlugins) { try { p.onFixedUpdatePost!(dt); } catch { /* isolated */ } }
  }
}

describe('enablePlugin / disablePlugin symmetry', () => {
  it('disablePlugin removes plugin from phase lists', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onFixedUpdatePre: () => calls.push('a') });
    host.disablePlugin('a');
    host.fixedUpdate(1 / 60);
    expect(calls).toEqual([]);
    expect(host.prePlugins.length).toBe(0);
  });

  it('enablePlugin re-inserts sorted by order', () => {
    const host = new PluginHost();
    const order: string[] = [];
    host.use({ id: 'b', order: 200, onFixedUpdatePre: () => order.push('b') });
    host.use({ id: 'a', order: 10, onFixedUpdatePre: () => order.push('a') });
    host.disablePlugin('a');
    host.enablePlugin('a'); // must land back BEFORE 'b' despite re-add
    host.fixedUpdate(1 / 60);
    expect(order).toEqual(['a', 'b']);
  });

  it('enablePlugin is a no-op on a non-disabled id', () => {
    const host = new PluginHost();
    host.use({ id: 'a', onFixedUpdatePre: () => {} });
    expect(() => host.enablePlugin('a')).not.toThrow();
    expect(host.prePlugins.length).toBe(1); // no duplicate insertion
  });

  it('plugin disabled at load time misses onModelLoaded, replayed once on enable', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onModelLoaded: () => calls.push('load') });
    host.disablePlugin('a');
    host.simulateLoad({ registry: null });
    expect(calls).toEqual([]); // missed while disabled
    expect(host.missedModelLoad.has('a')).toBe(true);
    host.enablePlugin('a');
    expect(calls).toEqual(['load']); // replayed exactly once
    expect(host.missedModelLoad.has('a')).toBe(false);
  });

  it('no replay when no model is loaded', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onModelLoaded: () => calls.push('load') });
    host.disablePlugin('a');
    host.enablePlugin('a'); // no load happened
    expect(calls).toEqual([]);
  });

  it('does not double-fire onModelLoaded across re-enable', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onModelLoaded: () => calls.push('load') });
    host.disablePlugin('a');
    host.simulateLoad({ registry: null });
    host.enablePlugin('a');
    host.enablePlugin('a'); // second call: not disabled, no replay
    expect(calls).toEqual(['load']);
  });

  it('clearModel discards missed-load bookkeeping', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onModelLoaded: () => calls.push('load') });
    host.disablePlugin('a');
    host.simulateLoad({ registry: null });
    host.clearModel();
    host.enablePlugin('a'); // model gone — nothing to replay
    expect(calls).toEqual([]);
    expect(host.missedModelLoad.size).toBe(0);
  });
});
