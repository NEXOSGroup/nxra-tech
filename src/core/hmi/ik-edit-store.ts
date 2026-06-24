// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-edit-store.ts — Bridge between IKTargetEditPlugin (3D) and the React popover.
 *
 * The plugin pushes the active pathpoint (its editable IKTarget values + a controller
 * for mutations) here; the IKTargetQuickEdit content reads it via useSyncExternalStore.
 * The live world anchor is supplied separately via the generic popover request's
 * getWorld() closure (projected each frame by AnchoredPopover).
 */

export interface IKEditValues {
  interpolation: string;        // 'PointToPoint' | 'PointToPointUnsynced' | 'Linear'
  speedToTarget: number;        // 0..1
  linearSpeed: number;          // mm/s
  linearAccel: number;          // mm/s^2
  enableBlending: boolean;
  blendRadius: number;          // mm
  waitForSeconds: number;       // s
  pickAndPlace: boolean;
}

export interface IKEditActive extends IKEditValues {
  /** Target node path (stable identity for React keys). */
  path: string;
  name: string;
  /** True while the current pose is reachable by the solver (red ring otherwise). */
  reachable: boolean;
}

export interface IKEditController {
  setProp<K extends keyof IKEditValues>(field: K, value: IKEditValues[K]): void;
  /** Insert a new waypoint before / after the active one (interpolated pose). */
  addPoint(where: 'before' | 'after'): void;
  deleteTarget(): void;
  driveHere(): void;
  close(): void;
}

class IKEditStore {
  private _active: IKEditActive | null = null;
  private _controller: IKEditController | null = null;
  private readonly _listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => { this._listeners.add(l); return () => { this._listeners.delete(l); }; };
  getSnapshot = (): IKEditActive | null => this._active;

  getController(): IKEditController | null { return this._controller; }

  setActive(active: IKEditActive, controller: IKEditController): void {
    this._active = active; this._controller = controller; this._notify();
  }
  /** Merge changed editable values (after an edit) and re-render. */
  updateValues(v: Partial<IKEditValues> & { reachable?: boolean }): void {
    if (!this._active) return;
    this._active = { ...this._active, ...v };
    this._notify();
  }
  clear(): void {
    if (!this._active) return;
    this._active = null; this._controller = null; this._notify();
  }

  private _notify(): void { for (const l of this._listeners) l(); }
}

export const ikEditStore = new IKEditStore();
