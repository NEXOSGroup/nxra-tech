// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared signal + drive construction helpers used by both `traverseAndRegister()`
 * and `processExtras()` in rv-scene-loader.ts.
 *
 * The two traversal functions are intentionally kept separate — `traverseAndRegister()`
 * is the rich main-load path (with overlays, renamed-node aliases, validation,
 * MU template + group + kinematic + pipeline + metadata collection), while
 * `processExtras()` is a deliberately leaner re-registration path for dynamically
 * added GLBs (layout planner). Only the *inner* signal and drive construction
 * primitives are shared here — the traversal control flow remains divergent.
 */

import type { Object3D } from 'three';
import { RVDrive } from './rv-drive';
import { RVErraticDriver } from './rv-erratic';
import { RVDriveSimple } from './rv-drive-simple';
import { RVDriveCylinder } from './rv-drive-cylinder';
import { applySchema, type RVComponent, type ComponentSchema } from './rv-component-registry';
import type { SignalStore } from './rv-signal-store';
import type { NodeRegistry } from './rv-node-registry';

/** Pending component awaiting resolveComponentRefs + init() in the caller's Step 2 phase. */
export interface PendingComponentEntry {
  component: RVComponent;
  type: string;
  path: string;
}

/** Result of `constructDrive` — the constructed drive plus any pending behavior components. */
export interface ConstructDriveResult {
  drive: RVDrive;
  pendingBehaviors: PendingComponentEntry[];
  behaviors: string[];
}

/** Map of known drive behavior types → class + schema for data-driven instantiation.
 *  Kept in sync with the inline map previously in rv-scene-loader.ts so both
 *  traversal paths recognize the same behaviors. */
export const DRIVE_BEHAVIOR_MAP: Record<string, { ctor: new (n: Object3D) => RVComponent; schema: ComponentSchema }> = {
  Drive_ErraticPosition: { ctor: RVErraticDriver, schema: RVErraticDriver.schema },
  Drive_Simple: { ctor: RVDriveSimple, schema: RVDriveSimple.schema },
  Drive_Cylinder: { ctor: RVDriveCylinder, schema: RVDriveCylinder.schema },
};

/** Signal type names recognized from GLB extras. */
export const SIGNAL_TYPES = ['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt'];

/**
 * Register a PLC signal in the SignalStore and the NodeRegistry, identical
 * to the inline logic that previously lived in `traverseAndRegister()` and
 * `processExtras()`.
 *
 * Side-effects (must exactly mirror the original inline code):
 *  - `signalStore.register(signalName, path, initialValue, sigType)`
 *  - `registry.register(sigType, path, { address: path, signalName })`
 *
 * @param node      The node carrying the signal extras (used only for the default name fallback).
 * @param sigType   The signal type key (one of `SIGNAL_TYPES`).
 * @param sigData   The raw extras record for the signal (already validated by the caller if needed).
 * @param path      Pre-computed node path (caller controls path computation).
 * @param signalStore  Target SignalStore.
 * @param registry  Target NodeRegistry.
 * @param signalNameOverride Optional explicit name; when provided, used as the
 *   second-priority lookup *before* falling back to `node.name`. Used by
 *   `traverseAndRegister()` to inject the original renamed-node name; the
 *   leaner `processExtras()` path passes `undefined`.
 * @returns `true` if a signal was registered, `false` if `sigType` was not
 *          recognized as Bool/Float/Int (defensive: no-op on unknown types).
 */
export function registerSignal(
  node: Object3D,
  sigType: string,
  sigData: Record<string, unknown>,
  path: string,
  signalStore: SignalStore,
  registry: NodeRegistry,
  signalNameOverride?: string,
): boolean {
  const status = sigData['Status'] as { Value?: boolean | number } | undefined;
  const signalName = (sigData['Name'] as string) || signalNameOverride || node.name;

  if (sigType.includes('Bool')) {
    signalStore.register(signalName, path, (status?.Value as boolean) ?? false, sigType);
  } else if (sigType.includes('Float')) {
    signalStore.register(signalName, path, (status?.Value as number) ?? 0, sigType);
  } else if (sigType.includes('Int')) {
    signalStore.register(signalName, path, (status?.Value as number) ?? 0, sigType);
  } else {
    // Defensive: unknown signal type — do nothing, do not register a phantom
    // entry in the registry either. The original inline code only registered
    // the registry entry inside the if/else-if chain implicitly via the
    // surrounding `if (rv[sigType])` guard, but registry.register() was called
    // unconditionally after the type dispatch. We preserve that behavior for
    // *known* types and skip both calls for unknown types.
    return false;
  }

  registry.register(sigType, path, { address: path, signalName });
  return true;
}

/**
 * Construct an `RVDrive` from extras and collect any recognized `Drive_*`
 * behavior components. Mirrors the inline construction that previously lived
 * in both `traverseAndRegister()` and `processExtras()`.
 *
 * Side-effects (must exactly mirror the original inline code):
 *  - Creates RVDrive(node), applySchema(...)
 *  - Sets drive.Behaviors / drive.BehaviorExtras
 *  - Calls drive.initDrive()
 *  - Registers the drive in registry under type "Drive"
 *  - Sets node.userData._rvType = 'Drive'
 *  - Instantiates Drive_* behavior components via DRIVE_BEHAVIOR_MAP +
 *    applySchema and returns them as pending entries
 *
 * Behavior validation (`validateExtras(key, bExtras)`) is intentionally NOT
 * performed here — it is the caller's responsibility, because
 * `traverseAndRegister()` validates while `processExtras()` does not.
 *
 * @param node     The drive node.
 * @param rv       The full `userData.realvirtual` record (used to scan for Drive_* keys).
 * @param driveData The 'Drive' sub-record from rv (extras already pulled out by caller).
 * @param path     Pre-computed node path.
 * @param registry Target registry.
 * @param onBehaviorExtras Optional callback fired for each discovered Drive_*
 *   behavior name + its extras record — used by `traverseAndRegister()` to run
 *   `validateExtras()` per behavior. `processExtras()` passes `undefined`.
 * @returns the constructed drive + collected pending behavior entries, OR
 *          `null` if `driveData.Direction` is missing/falsy (matching the
 *          original guard).
 */
export function constructDrive(
  node: Object3D,
  rv: Record<string, unknown>,
  driveData: Record<string, unknown>,
  path: string,
  registry: NodeRegistry,
  onBehaviorExtras?: (behaviorKey: string, behaviorExtras: Record<string, unknown>) => void,
): ConstructDriveResult | null {
  const dirStr = driveData['Direction'] as string | undefined;
  if (!dirStr) return null;

  const drive = new RVDrive(node);
  applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, driveData);

  // Collect DriveBehaviours
  const behaviors: string[] = [];
  const behaviorExtras: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(rv)) {
    if (key !== 'Drive' && key.startsWith('Drive_')) {
      behaviors.push(key);
      const bExtras = rv[key] as Record<string, unknown>;
      behaviorExtras[key] = bExtras;
      if (onBehaviorExtras) onBehaviorExtras(key, bExtras);
    }
  }
  drive.Behaviors = behaviors;
  drive.BehaviorExtras = behaviorExtras;
  drive.initDrive();

  registry.register('Drive', path, drive);
  node.userData._rvType = 'Drive';

  // Instantiate recognized drive behaviors via data-driven map
  const pendingBehaviors: PendingComponentEntry[] = [];
  for (const bName of behaviors) {
    const entry = DRIVE_BEHAVIOR_MAP[bName];
    if (entry) {
      const inst = new entry.ctor(node);
      applySchema(inst as unknown as Record<string, unknown>, entry.schema, behaviorExtras[bName] ?? {});
      pendingBehaviors.push({ component: inst, type: bName, path });
    }
  }

  return { drive, pendingBehaviors, behaviors };
}
