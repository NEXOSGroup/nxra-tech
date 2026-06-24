// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-executors — Apply EditOps to the live RVViewer scene.
 *
 * For every primitive `EditOp.kind`, this module provides:
 *   - applyForward(op):  mutate the live scene to reflect the op
 *   - applyInverse(op):  reverse the op using its `prev` payload
 *
 * Composite ops fan out to their primitives (forward in order, inverse in
 * reverse). All execution paths are wrapped in try/catch — a failed op never
 * throws across the SceneStore boundary, only logs a warning. This is what
 * lets a saved scene whose base GLB later changed (some node went missing)
 * still load: stale ops are skipped, the rest replay cleanly.
 *
 * The executors are async: `addPlacement` may need to load a GLB. The
 * SceneStore op queue is single-flight, so two ops never run concurrently.
 */

import type { RVViewer } from '../../rv-viewer';
import type { LayoutPlannerPlugin } from '../../../plugins/layout-planner';
import type {
  EditOp,
  PrimitiveEditOp,
  SetFieldOp,
  UnsetFieldOp,
  AddPlacementOp,
  RemovePlacementOp,
  TransformPlacementOp,
  SetCameraOp,
  AddNodeOp,
  RemoveNodeOp,
} from './rv-scene-edits';
import { saveStartPos, clearStartPos } from '../camera-startpos-store';
import { deriveModelKey } from '../../../plugins/camera-startpos-plugin';
import { applySchema, getRegisteredFactories } from '../../engine/rv-component-registry';

export interface ExecutorContext {
  viewer: RVViewer;
}

// ─── Public entry points ────────────────────────────────────────────────

export async function applyForward(op: EditOp, ctx: ExecutorContext): Promise<void> {
  if (op.kind === 'composite') {
    for (const child of op.ops) await applyForward(child, ctx);
    return;
  }
  try {
    await applyPrimitiveForward(op, ctx);
  } catch (e) {
    console.warn(`[scene-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
  }
}

export async function applyInverse(op: EditOp, ctx: ExecutorContext): Promise<void> {
  if (op.kind === 'composite') {
    for (let i = op.ops.length - 1; i >= 0; i--) {
      await applyInverse(op.ops[i], ctx);
    }
    return;
  }
  try {
    await applyPrimitiveInverse(op, ctx);
  } catch (e) {
    console.warn(`[scene-edits] inverse apply failed for ${op.kind} (op ${op.id}):`, e);
  }
}

async function applyPrimitiveForward(op: PrimitiveEditOp, ctx: ExecutorContext): Promise<void> {
  switch (op.kind) {
    case 'setField':           return setFieldForward(op, ctx);
    case 'unsetField':         return unsetFieldForward(op, ctx);
    case 'addPlacement':       return addPlacementForward(op, ctx);
    case 'removePlacement':    return removePlacementForward(op, ctx);
    case 'transformPlacement': return transformPlacementForward(op, ctx);
    case 'setCamera':          return setCameraForward(op, ctx);
    case 'addNode':            return addNodeForward(op, ctx);
    case 'removeNode':         return removeNodeForward(op, ctx);
  }
}

async function applyPrimitiveInverse(op: PrimitiveEditOp, ctx: ExecutorContext): Promise<void> {
  switch (op.kind) {
    case 'setField':           return setFieldInverse(op, ctx);
    case 'unsetField':         return unsetFieldInverse(op, ctx);
    case 'addPlacement':       return addPlacementInverse(op, ctx);
    case 'removePlacement':    return removePlacementInverse(op, ctx);
    case 'transformPlacement': return transformPlacementInverse(op, ctx);
    case 'setCamera':          return setCameraInverse(op, ctx);
    case 'addNode':            return addNodeInverse(op, ctx);
    case 'removeNode':         return removeNodeInverse(op, ctx);
  }
}

// ─── addNode / removeNode ───────────────────────────────────────────────

function addNodeForward(op: AddNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.createComponentNode(op.spec);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function addNodeInverse(op: AddNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.removeComponentNode(op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function removeNodeForward(op: RemoveNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.removeComponentNode(op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function removeNodeInverse(op: RemoveNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.createComponentNode(op.spec);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

// ─── setField / unsetField ──────────────────────────────────────────────

function setFieldForward(op: SetFieldOp, ctx: ExecutorContext): void {
  writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.value);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  ctx.viewer.markRenderDirty?.();
}

function setFieldInverse(op: SetFieldOp, ctx: ExecutorContext): void {
  // Inverse of setField: restore prev. If prev was undefined the field was
  // never set on the original GLB — delete the override entirely.
  if (op.prev === undefined) {
    deleteUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName);
  } else {
    writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  }
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  ctx.viewer.markRenderDirty?.();
}

function unsetFieldForward(op: UnsetFieldOp, ctx: ExecutorContext): void {
  deleteUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  ctx.viewer.markRenderDirty?.();
}

function unsetFieldInverse(op: UnsetFieldOp, ctx: ExecutorContext): void {
  // Inverse of unset: restore the prev value.
  writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  ctx.viewer.markRenderDirty?.();
}

function writeUserDataField(
  viewer: RVViewer, nodePath: string, componentType: string, fieldName: string, value: unknown,
): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const ud = node.userData as Record<string, unknown>;
  let rv = ud['realvirtual'] as Record<string, Record<string, unknown>> | undefined;
  if (!rv) { rv = {}; ud['realvirtual'] = rv; }
  if (!rv[componentType]) rv[componentType] = {};
  rv[componentType][fieldName] = value;
}

function deleteUserDataField(
  viewer: RVViewer, nodePath: string, componentType: string, fieldName: string,
): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const compOv = rv?.[componentType];
  if (!compOv) return;
  delete compOv[fieldName];
  if (Object.keys(compOv).length === 0) delete rv![componentType];
}

/**
 * Push the updated `userData.realvirtual` values back into the live component
 * instance via the registered schema (so e.g. RVDrive.TargetSpeed reflects
 * the new value at runtime — not just inside userData).
 */
function reapplySchemaForComponent(viewer: RVViewer, nodePath: string, componentType: string): void {
  const reg = viewer.registry;
  if (!reg) return;
  const components = reg.getComponentsAt(nodePath);
  if (!components || components.length === 0) return;
  const entry = components.find(([type]) => type === componentType);
  if (!entry) return;
  const instance = entry[1];
  const node = reg.getNode(nodePath);
  if (!node) return;
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const data = rv?.[componentType] ?? {};

  // Find the schema. Most components register via `getRegisteredFactories`;
  // a few (Drive, drive behaviors) have their schema on the class itself.
  const factory = getRegisteredFactories().get(componentType);
  if (factory) {
    applySchema(instance as unknown as Record<string, unknown>, factory.schema, data);
    return;
  }
  // Fallback: instance carries a static `schema` field (Drive / drive behaviors).
  const ctor = (instance as object).constructor as { schema?: Record<string, unknown> } | undefined;
  if (ctor?.schema) {
    applySchema(instance as unknown as Record<string, unknown>, ctor.schema as never, data);
  }
}

// ─── addPlacement / removePlacement / transformPlacement ────────────────

async function addPlacementForward(op: AddPlacementOp, ctx: ExecutorContext): Promise<void> {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  if (!planner) throw new Error('LayoutPlannerPlugin not registered');
  await planner.placeFromRecord(op.placement);
}

function addPlacementInverse(op: AddPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.removePlacementById(op.placement.id);
}

function removePlacementForward(op: RemovePlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.removePlacementById(op.placementId);
}

async function removePlacementInverse(op: RemovePlacementOp, ctx: ExecutorContext): Promise<void> {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  if (!planner) throw new Error('LayoutPlannerPlugin not registered');
  await planner.placeFromRecord(op.placement);
}

function transformPlacementForward(op: TransformPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.applyTransformById(op.placementId, op.position, op.rotation, op.scale);
}

function transformPlacementInverse(op: TransformPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.applyTransformById(op.placementId, op.prev.position, op.prev.rotation, op.prev.scale);
}

// ─── setCamera ──────────────────────────────────────────────────────────

function setCameraForward(op: SetCameraOp, ctx: ExecutorContext): void {
  const key = deriveModelKey(ctx.viewer.currentModelUrl);
  if (!key) return;
  if (op.preset) saveStartPos(key, op.preset);
  else clearStartPos(key);
  // Kick the camera plugin to re-tween if it wants. The CAMERA_START_CHANGED
  // event fires from the saveStartPos / clearStartPos helpers automatically.
}

function setCameraInverse(op: SetCameraOp, ctx: ExecutorContext): void {
  const key = deriveModelKey(ctx.viewer.currentModelUrl);
  if (!key) return;
  if (op.prev) saveStartPos(key, op.prev);
  else clearStartPos(key);
}
