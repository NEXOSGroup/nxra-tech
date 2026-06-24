// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-target-edit-plugin.ts — Interactive IK target editing with a custom gizmo.
 *
 * Selecting a robot (or one of its IKTargets) makes its path waypoints editable:
 * move the pointer near a pathpoint → a translate/rotate gizmo pops on it; grab an
 * axis arrow (move), a ring (rotate the TCP orientation), or the centre (free move).
 * The robot's joints re-solve (Pieper WASM solver) and follow in real time, and a
 * semi-transparent GHOST of the robot's axis-6 / tool shows the target pose.
 *
 * Each visible handle has a fat INVISIBLE picker mesh so it's easy to grab. A
 * CAPTURE-phase pointerdown on `window` runs before the planner's canvas handlers:
 * if it hits one of our pickers we claim the event (stopPropagation) so box-select /
 * orbit / selection never start. Orbit is disabled only while actively dragging.
 *
 * Performance: pointer listeners attach only while a robot is selected; onRender
 * early-returns unless the gizmo is visible — zero cost in normal mode.
 */

import {
  Group, Mesh, MeshBasicMaterial, CylinderGeometry, ConeGeometry, SphereGeometry, TorusGeometry,
  Raycaster, Plane, Vector2, Vector3, Matrix4, Quaternion, DoubleSide,
} from 'three';
import type { Object3D, Material } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { SelectionSnapshot } from '../core/engine/rv-selection-manager';
import { ikSolverRegistry, targetPoseInBase, type OpwParams } from '../core/engine/rv-ik-solver';
import type { RVRobotIK } from '../core/engine/rv-robot-ik';
import type { RVDrive } from '../core/engine/rv-drive';
import type { RVIKTarget } from '../core/engine/rv-ik-target';
import { isRef, type RVIKPath } from '../core/engine/rv-ik-path';
import type { ComponentRef } from '../core/engine/rv-node-registry';
import { ikEditStore, type IKEditController, type IKEditValues, type IKEditActive } from '../core/hmi/ik-edit-store';
import { popoverStore } from '../core/hmi/popover-store';
import { persistFieldOp } from '../core/hmi/scene/scene-field-ops';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';
import { freshOpId } from '../core/hmi/scene/rv-scene-edits';
import type { RuntimeNodeSpec } from '../core/engine/rv-scene-loader';

/** IKEditValues key → IKTarget rv_extras / schema field name. */
const IK_FIELD_MAP: Record<keyof IKEditValues, string> = {
  interpolation: 'InterpolationToTarget',
  speedToTarget: 'SpeedToTarget',
  linearSpeed: 'LinearSpeedToTarget',
  linearAccel: 'LinearAcceleration',
  enableBlending: 'EnableBlending',
  blendRadius: 'BlendRadius',
  waitForSeconds: 'WaitForSeconds',
  pickAndPlace: 'PickAndPlace',
};

const GRAB_RADIUS_PX = 44;
const GIZMO_SCREEN_SCALE = 0.075;
type Handle = 'x' | 'y' | 'z' | 'center' | 'rx' | 'ry' | 'rz';
const AX: Record<'x' | 'y' | 'z', Vector3> = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };

interface Candidate { node: Object3D; robot: RVRobotIK; params: OpwParams; drives: RVDrive[]; target: RVIKTarget; ikPath: RVIKPath; }
interface Drag {
  c: Candidate; kind: 'axis' | 'plane' | 'rotate'; axisDir: Vector3;
  startWorld: Vector3; plane: Plane; grab: number; offset: Vector3;
  startQuat: Quaternion; refVec: Vector3;
}

export class IKTargetEditPlugin implements RVViewerPlugin {
  readonly id = 'ik-target-edit';

  private viewer: RVViewer | null = null;
  private unsub: (() => void) | null = null;
  private _listening = false;

  private candidates: Candidate[] = [];
  private gizmo: Group | null = null;
  private active: Candidate | null = null;
  private drag: Drag | null = null;
  private prevControlsEnabled = true;
  /** One semi-transparent tool ghost per pathpoint (shown when no point is being edited). */
  private readonly ghosts = new Map<Candidate, Group>();
  private ghostMat: MeshBasicMaterial | null = null;

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly _v = new Vector3();
  private readonly _hit = new Vector3();
  private readonly _mat = new Matrix4();
  private readonly _pos = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _q2 = new Quaternion();
  private readonly _dPos = new Vector3();
  private readonly _dScl = new Vector3();
  private readonly _wtmp = new Vector3();
  // Reusable solver tuples (avoid per-frame allocation during drag / live anchor).
  private readonly _p3: [number, number, number] = [0, 0, 0];
  private readonly _q4: [number, number, number, number] = [0, 0, 0, 1];
  private readonly _seed: number[] = [0, 0, 0, 0, 0, 0];
  private readonly _worldTuple: [number, number, number] = [0, 0, 0];
  private _lastSnap: SelectionSnapshot | null = null;
  /** Guards onClose recursion while we replace/hide the popover ourselves. */
  private _suppressClose = false;

  // ── World read/write that respects the loader's frozen matrixWorld ──
  // Static nodes are frozen (matrixWorldAutoUpdate=false, baked matrixWorld). Calling
  // getWorldPosition()/updateWorldMatrix() RECOMPUTES from (often identity) local
  // matrices and corrupts the pose to the origin. So read straight from matrixWorld.
  private worldPos(node: Object3D, out: Vector3): Vector3 {
    return out.setFromMatrixPosition(node.matrixWorld);
  }
  private worldQuat(node: Object3D, out: Quaternion): Quaternion {
    node.matrixWorld.decompose(this._dPos, out, this._dScl);
    return out;
  }
  /** Make a frozen target node movable: rebuild its local transform from the baked
   *  matrixWorld, then re-enable auto-update so position changes take effect. */
  private ensureMovable(node: Object3D): void {
    const ud = node.userData as Record<string, unknown>;
    if (ud.__rvMovable) return;
    const parent = node.parent;
    if (parent) {
      this._mat.copy(parent.matrixWorld).invert().multiply(node.matrixWorld);
      this._mat.decompose(node.position, node.quaternion, node.scale);
    }
    node.matrixAutoUpdate = true;
    node.matrixWorldAutoUpdate = true;
    ud.__rvMovable = true;
  }

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.unsub = viewer.on('selection-changed', (s) => this.onSelection(s));
    // pointerdown stays live (click-frequency only) so a robot can be picked — and its
    // path edited — even in planner mode, where the planner's canvas handler would
    // otherwise treat the robot as empty canvas and start a box-select.
    window.addEventListener('pointerdown', this._onPointerDown as EventListener, true);
  }

  onModelCleared(): void {
    this.endDrag(); this.candidates = []; this.hideGizmo(); this.clearGhosts(); this.setListeners(false);
  }

  dispose(): void {
    this.endDrag(); this.unsub?.(); this.unsub = null; this.setListeners(false);
    window.removeEventListener('pointerdown', this._onPointerDown as EventListener, true);
    this.clearGhosts();
    this.ghostMat?.dispose(); this.ghostMat = null;
    if (this.viewer && this.gizmo) { this.viewer.scene.remove(this.gizmo); this.disposeObject(this.gizmo); }
    this.gizmo = null; this.viewer = null;
  }

  onRender(): void {
    const g = this.gizmo, viewer = this.viewer;
    if (!g || !g.visible || !viewer) return;
    g.scale.setScalar(viewer.camera.position.distanceTo(g.position) * GIZMO_SCREEN_SCALE);
  }

  /** Attach move/up only while editing (perf). pointerdown is always live (see init). */
  private setListeners(on: boolean): void {
    if (on === this._listening) return;
    this._listening = on;
    // NOTE: call window.addEventListener directly — assigning it to a local var
    // detaches the `this` binding and throws "Illegal invocation".
    if (on) {
      window.addEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.addEventListener('pointerup', this._onPointerUp as EventListener, true);
    } else {
      window.removeEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.removeEventListener('pointerup', this._onPointerUp as EventListener, true);
    }
  }

  // ── Selection → candidate pathpoints ──

  private onSelection(snap: SelectionSnapshot): void {
    const viewer = this.viewer;
    this._lastSnap = snap;
    this.candidates = []; this.hideGizmo(); this.clearGhosts();
    if (viewer?.registry) {
      const seen = new Set<RVRobotIK>();
      for (const path of snap.selectedPaths) {
        const node = viewer.registry.getNode(path);
        if (!node) continue;
        const robot = viewer.registry.findInParent<RVRobotIK>(node, 'RobotIK');
        if (!robot || seen.has(robot)) continue;
        seen.add(robot);
        const params = robot.getOpwParams();
        const drives = robot.getAxisDrives();
        if (!params || drives.length < 6) continue;
        for (const p of robot.getPaths()) for (const t of p.targets) this.candidates.push({ node: t.node, robot, params, drives, target: t, ikPath: p });
      }
    }
    this.setListeners(this.candidates.length > 0);
    // Robot/path selected but no point being edited yet → show a tool ghost at each waypoint.
    if (this.candidates.length) { this.buildGhosts(); this.setGhostsVisible(true); }
  }

  // ── Pointer handling (capture phase) ──

  private readonly _onPointerDown = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer || e.button !== 0 || !this.withinCanvas(e)) return;
    // Clicks on the floating popover must not reach the plugin. The popover's own
    // stopPropagation can't help: this listener is capture-phase (runs first).
    if ((e.target as HTMLElement | null)?.closest?.('[data-rv-popover]')) return;
    // 1) Gizmo is up and we grabbed a handle → start dragging.
    if (this.gizmo?.visible && this.active) {
      const handle = this.pickHandle(e);
      if (handle) { e.stopPropagation(); e.preventDefault(); this.beginDrag(e, handle); return; }
    }
    // 2) Clicked near a pathpoint → pop the gizmo there (sticky), hide ghosts and
    //    preview the robot at that point (re-solve).
    const c = this.nearestCandidate(e);
    if (c) {
      e.stopPropagation(); e.preventDefault();
      this.activate(c);
      return;
    }
    // 3) Clicked a robot mesh → select it (works in planner mode too) so its path
    //    points become editable. Claim the click so the planner won't box-select.
    const robot = this.pickRobot(e);
    if (robot) {
      const path = viewer.registry?.getPathForNode(robot.node);
      if (path) { e.stopPropagation(); e.preventDefault(); viewer.selectionManager.select(path); return; }
    }
    // 4) Clicked elsewhere → leave the gizmo sticky so orbit (drag-empty) doesn't lose
    //    it. A real deselect re-fires onSelection and clears the gizmo + ghosts.
  };

  private beginDrag(e: PointerEvent, handle: Handle): void {
    const viewer = this.viewer!;
    const c = this.active!;
    this.ensureMovable(c.node);
    this.prevControlsEnabled = viewer.controls.enabled;
    viewer.controls.enabled = false;
    const startWorld = this.worldPos(c.node, new Vector3());
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const d: Drag = {
      c, kind: 'plane', axisDir: new Vector3(), startWorld,
      plane: new Plane(), grab: 0, offset: new Vector3(),
      startQuat: this.worldQuat(c.node, new Quaternion()), refVec: new Vector3(),
    };
    if (handle === 'center') {
      d.kind = 'plane';
      d.plane.setFromNormalAndCoplanarPoint(viewer.camera.getWorldDirection(new Vector3()), startWorld);
      if (this.raycaster.ray.intersectPlane(d.plane, this._hit)) d.offset.subVectors(startWorld, this._hit);
    } else if (handle === 'x' || handle === 'y' || handle === 'z') {
      // Axis in the TCP frame: rotate the local axis by the target's world orientation.
      d.kind = 'axis'; d.axisDir.copy(AX[handle]).applyQuaternion(d.startQuat).normalize();
      d.grab = this.closestOnAxis(startWorld, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
    } else {
      d.kind = 'rotate'; d.axisDir.copy(AX[handle[1] as 'x' | 'y' | 'z']).applyQuaternion(d.startQuat).normalize();
      d.plane.setFromNormalAndCoplanarPoint(d.axisDir, startWorld);
      if (this.raycaster.ray.intersectPlane(d.plane, this._hit)) d.refVec.subVectors(this._hit, startWorld);
    }
    this.drag = d;
    try { viewer.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer) return;
    if (!this.drag) {
      // Sticky model: never show/hide on hover (arrows reach beyond the point).
      // Only hint the cursor: 'grab' over a gizmo handle, 'pointer' near a point.
      if (this.candidates.length && this.withinCanvas(e)) {
        const overHandle = this.gizmo?.visible && this.active ? this.pickHandle(e) : null;
        viewer.renderer.domElement.style.cursor = overHandle ? 'grab' : (this.nearestCandidate(e) ? 'pointer' : '');
      }
      return;
    }
    e.stopPropagation();
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const d = this.drag, node = d.c.node, parent = node.parent;
    if (d.kind === 'rotate') {
      if (!this.raycaster.ray.intersectPlane(d.plane, this._hit)) return;
      this._v.subVectors(this._hit, d.startWorld);
      const angle = this.signedAngle(d.refVec, this._v, d.axisDir);
      this._q.setFromAxisAngle(d.axisDir, angle).multiply(d.startQuat); // desired world quat
      if (parent) { this.worldQuat(parent, this._q2).invert().multiply(this._q); node.quaternion.copy(this._q2); }
      else node.quaternion.copy(this._q);
    } else {
      if (d.kind === 'axis') {
        const s = this.closestOnAxis(d.startWorld, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
        this._v.copy(d.startWorld).addScaledVector(d.axisDir, s - d.grab);
      } else {
        if (!this.raycaster.ray.intersectPlane(d.plane, this._hit)) return;
        this._v.addVectors(this._hit, d.offset);
      }
      // World target → parent-local via the BAKED parent.matrixWorld directly
      // (parent.worldToLocal() calls updateWorldMatrix → corrupts frozen ancestors).
      // _v is mutated in place — its world value isn't needed after this.
      if (parent) { this._mat.copy(parent.matrixWorld).invert(); node.position.copy(this._v.applyMatrix4(this._mat)); }
      else node.position.copy(this._v);
    }
    // Refresh node.matrixWorld from the correct parent.matrixWorld — no recursion.
    node.updateMatrix();
    if (parent) node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
    else node.matrixWorld.copy(node.matrix);
    this.gizmo!.position.copy(this.worldPos(node, this._pos));
    this.gizmo!.quaternion.copy(this.worldQuat(node, this._q));
    const reach = this.resolve(d.c);
    const snap = ikEditStore.getSnapshot();
    if (snap && snap.reachable !== reach) ikEditStore.updateValues({ reachable: reach });
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopPropagation();
    try { this.viewer?.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.endDrag();
  };

  private endDrag(): void {
    const viewer = this.viewer;
    if (this.drag && viewer) viewer.controls.enabled = this.prevControlsEnabled;
    this.drag = null;
    if (viewer) viewer.renderer.domElement.style.cursor = '';
  }

  // ── Gizmo geometry (visible + fat invisible pickers) ──

  private ensureGizmo(): Group {
    if (this.gizmo) return this.gizmo;
    const g = new Group(); g.name = '__rvIKGizmo';
    const pickMat = () => new MeshBasicMaterial({ visible: true, transparent: true, opacity: 0, depthTest: false, depthWrite: false });

    const mkAxis = (h: Handle, color: number, dir: Vector3) => {
      const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true });
      const shaft = new Mesh(new CylinderGeometry(0.018, 0.018, 0.7, 8), mat); shaft.position.y = 0.35;
      const head = new Mesh(new ConeGeometry(0.07, 0.18, 12), mat); head.position.y = 0.78;
      const picker = new Mesh(new CylinderGeometry(0.3, 0.3, 1.0, 6), pickMat()); picker.position.y = 0.5;
      picker.userData.gizmoHandle = h;
      const grp = new Group(); grp.add(shaft, head, picker);
      grp.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
      return grp;
    };
    g.add(mkAxis('x', 0xff4d4d, AX.x), mkAxis('y', 0x4dff4d, AX.y), mkAxis('z', 0x4d9dff, AX.z));

    const mkRing = (h: Handle, color: number, normal: Vector3) => {
      const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9, side: DoubleSide });
      const ring = new Mesh(new TorusGeometry(0.55, 0.016, 8, 48), mat);
      const picker = new Mesh(new TorusGeometry(0.55, 0.18, 6, 24), pickMat()); picker.userData.gizmoHandle = h;
      const grp = new Group(); grp.add(ring, picker);
      grp.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
      return grp;
    };
    g.add(mkRing('rx', 0xff7a7a, AX.x), mkRing('ry', 0x7aff7a, AX.y), mkRing('rz', 0x7ab8ff, AX.z));

    const center = new Mesh(new SphereGeometry(0.1, 16, 16), new MeshBasicMaterial({ color: 0xffd24d, depthTest: false, transparent: true, opacity: 0.85 }));
    center.userData.gizmoHandle = 'center'; g.add(center);

    g.traverse((o) => { o.renderOrder = 11000; });
    g.visible = false;
    this.viewer!.scene.add(g);
    this.gizmo = g;
    return g;
  }

  private showGizmoAt(c: Candidate): void {
    const g = this.ensureGizmo();
    this.ensureMovable(c.node);
    g.position.copy(this.worldPos(c.node, this._pos));
    g.quaternion.copy(this.worldQuat(c.node, this._q)); // align gizmo to the TCP / tool frame
    g.visible = true;
  }

  /** Activate a pathpoint: pop the gizmo, hide ghosts, re-solve the robot to it and
   *  open the Quick-Edit context popover anchored at the point. */
  private activate(c: Candidate): void {
    this.active = c;
    this.showGizmoAt(c);
    this.setGhostsVisible(false);
    const reachable = this.resolve(c);
    // Show the popover BEFORE setActive so a replaced previous request's onClose
    // (suppressed) can't wipe the new edit state.
    this._suppressClose = true;
    popoverStore.show({ id: 'ik-target', getWorld: this._getActiveWorld, onClose: this._onPopoverClose });
    this._suppressClose = false;
    ikEditStore.setActive(this.buildActive(c, reachable), this.controller);
  }

  private hideGizmo(): void {
    if (this.gizmo) this.gizmo.visible = false;
    this.active = null;
    this._suppressClose = true;
    popoverStore.hide('ik-target');
    this._suppressClose = false;
    ikEditStore.clear();
  }

  /** Live world anchor for the popover (read straight from the frozen-safe matrixWorld).
   *  Returns a reusable tuple — the popover reads it synchronously each frame. */
  private readonly _getActiveWorld = (): [number, number, number] => {
    if (this.active) {
      const w = this.worldPos(this.active.node, this._wtmp);
      this._worldTuple[0] = w.x; this._worldTuple[1] = w.y; this._worldTuple[2] = w.z;
    }
    return this._worldTuple;
  };

  /** Popover dismissed externally (Escape / replaced): drop the gizmo, restore ghosts. */
  private readonly _onPopoverClose = (): void => {
    if (this._suppressClose) return;
    this.hideGizmo();
    if (this.candidates.length) this.setGhostsVisible(true);
  };

  // ── Quick-Edit controller (consumed by the React popover via ikEditStore) ──

  private readonly controller: IKEditController = {
    setProp: (field, value) => this.setProp(field, value),
    addPoint: (where) => this.addPathpoint(where),
    deleteTarget: () => this.deleteActiveTarget(),
    driveHere: () => { if (this.active) this.resolve(this.active); },
    close: () => { this.hideGizmo(); if (this.candidates.length) this.setGhostsVisible(true); },
  };

  private buildActive(c: Candidate, reachable: boolean): IKEditActive {
    const t = c.target;
    return {
      path: this.viewer?.registry?.getPathForNode(c.node) ?? c.node.uuid,
      name: c.node.name || 'Target',
      interpolation: t.InterpolationToTarget,
      speedToTarget: t.SpeedToTarget,
      linearSpeed: t.LinearSpeedToTarget,
      linearAccel: t.LinearAcceleration,
      enableBlending: t.EnableBlending,
      blendRadius: t.BlendRadius,
      waitForSeconds: t.WaitForSeconds,
      pickAndPlace: t.PickAndPlace,
      reachable,
    };
  }

  private setProp<K extends keyof IKEditValues>(field: K, value: IKEditValues[K]): void {
    const c = this.active;
    const t = c?.target;
    if (!c || !t) return;
    const fieldName = IK_FIELD_MAP[field];
    const prev = (t as unknown as Record<string, unknown>)[fieldName];
    // Optimistic instance write so the 3D view (e.g. segment color) updates now;
    // the setField op below re-applies the schema and persists it.
    switch (field) {
      case 'interpolation': t.InterpolationToTarget = value as RVIKTarget['InterpolationToTarget']; break;
      case 'speedToTarget': t.SpeedToTarget = value as number; break;
      case 'linearSpeed': t.LinearSpeedToTarget = value as number; break;
      case 'linearAccel': t.LinearAcceleration = value as number; break;
      case 'enableBlending': t.EnableBlending = value as boolean; break;
      case 'blendRadius': t.BlendRadius = value as number; break;
      case 'waitForSeconds': t.WaitForSeconds = value as number; break;
      case 'pickAndPlace': t.PickAndPlace = value as boolean; break;
    }
    ikEditStore.updateValues({ [field]: value } as Partial<IKEditValues>);
    const nodePath = this.viewer?.registry?.getPathForNode(c.node);
    if (nodePath) persistFieldOp(nodePath, 'IKTarget', fieldName, value, prev);
  }

  private deleteActiveTarget(): void {
    const c = this.active;
    const reg = this.viewer?.registry;
    const store = getSceneStore();
    if (!c) return;
    const idx = c.ikPath.targets.indexOf(c.target);
    if (idx >= 0) c.ikPath.removeTarget(idx); // optimistic runtime removal

    const ikNodePath = reg?.getPathForNode(c.ikPath.node);
    const targetPath = reg ? reg.getPathForNode(c.node) : null;
    const rawPath = (c.ikPath.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath']?.['Path'];
    if (store && reg && ikNodePath && targetPath && Array.isArray(rawPath)) {
      // Rewrite IKPath.Path without the deleted target (matched by node → robust
      // against dedup-renames / runtime reorders).
      const next = (rawPath as unknown[]).filter((r) => !(isRef(r) && reg.getNode((r as ComponentRef).path) === c.node));
      const isAdded = !!(c.node.userData as Record<string, unknown>)['__rvAdded'];
      const pathOp = { id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const, nodePath: ikNodePath, componentType: 'IKPath', fieldName: 'Path', value: next, prev: rawPath };
      if (isAdded) {
        // Added node: also remove it (and cancel its addNode) so it doesn't
        // resurrect on reload. Original GLB nodes only get dropped from the path.
        const spec = this.specFromNode(c.node, targetPath);
        void store.withTransaction('Delete path point', async () => {
          await store.applyOp(pathOp);
          await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath: targetPath, spec });
        });
      } else {
        void store.applyOp(pathOp);
      }
    }
    this.hideGizmo();
    this.refresh();
  }

  /** Insert a new waypoint before/after the active one and persist it (addNode +
   *  IKPath.Path setField). Pose = midpoint to the neighbor (or a nudge from the
   *  active point); AxisPos is pre-solved so replay works without the solver. */
  private addPathpoint(where: 'before' | 'after'): void {
    const viewer = this.viewer;
    const c = this.active;
    const reg = viewer?.registry;
    const store = getSceneStore();
    if (!viewer || !reg || !c || !store) return;
    const idx = c.ikPath.targets.indexOf(c.target);
    if (idx < 0) return;

    // New world pose: midpoint to the neighbor, or a small nudge if none.
    const pA = new Vector3(), qA = new Quaternion(), sA = new Vector3();
    c.node.matrixWorld.decompose(pA, qA, sA);
    const neighbor = c.ikPath.targets[where === 'before' ? idx - 1 : idx + 1]?.node ?? null;
    if (neighbor) {
      const pB = new Vector3(), qB = new Quaternion(), sB = new Vector3();
      neighbor.matrixWorld.decompose(pB, qB, sB);
      pA.lerp(pB, 0.5); qA.slerp(qB, 0.5);
    } else {
      pA.addScaledVector(new Vector3(1, 0, 0).applyQuaternion(qA), 0.15 * (sA.x || 1));
    }
    const newWorld = new Matrix4().compose(pA, qA, sA);

    // Pre-solve AxisPos (so AxisPos-replay works in builds without the solver).
    let axisPos: number[] = [];
    if (ikSolverRegistry.available) {
      targetPoseInBase(c.robot.node.matrixWorld, newWorld, this._p3, this._q4);
      const sols = ikSolverRegistry.solvePieper(c.params, this._p3, this._q4);
      for (let i = 0; i < 6; i++) this._seed[i] = c.drives[i]?.currentPosition ?? 0;
      const best = sols ? ikSolverRegistry.selectClosest(sols, this._seed) : null;
      if (best) axisPos = [...best];
    }

    // Local transform under the (frozen) parent.
    const parent = c.node.parent;
    const parentPath = parent ? reg.getPathForNode(parent) : null;
    if (!parent || !parentPath) return;
    const local = new Matrix4().copy(parent.matrixWorld).invert().multiply(newWorld);
    const lp = new Vector3(), lq = new Quaternion(), ls = new Vector3();
    local.decompose(lp, lq, ls);

    // Inherit the active target's IKTarget fields (minus per-point refs), set AxisPos.
    const srcRaw = (c.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKTarget'] ?? {};
    const comp: Record<string, unknown> = { ...srcRaw };
    for (const k of ['gripTarget', 'fixer', 'SetSignal', 'WaitForSignal']) delete comp[k];
    comp['AxisPos'] = axisPos;

    const name = `Target_${Date.now().toString(36)}`;
    const nodePath = parentPath + '/' + name;
    const spec: RuntimeNodeSpec = {
      parentPath, name,
      position: [lp.x, lp.y, lp.z], quaternion: [lq.x, lq.y, lq.z, lq.w], scale: [ls.x, ls.y, ls.z],
      components: { IKTarget: comp },
    };

    // New Path order with the inserted ref.
    const ikNodePath = reg.getPathForNode(c.ikPath.node);
    const rawPath = ((c.ikPath.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath']?.['Path'] as unknown[]) ?? [];
    if (!ikNodePath) return;
    const insertAt = where === 'before' ? idx : idx + 1;
    const nextPath = [...rawPath];
    nextPath.splice(insertAt, 0, { type: 'ComponentReference', path: nodePath });

    // Order matters: setField(Path) first so addNode's rebuildIKPaths sees the ref.
    void store.withTransaction(where === 'before' ? 'Insert path point' : 'Add path point', async () => {
      await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField', nodePath: ikNodePath, componentType: 'IKPath', fieldName: 'Path', value: nextPath, prev: rawPath });
      await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath, spec });
    }).then(() => this.refresh());
  }

  /** Reconstruct a RuntimeNodeSpec from a live op-created node (for removeNode undo). */
  private specFromNode(node: Object3D, nodePath: string): RuntimeNodeSpec {
    const parentPath = nodePath.slice(0, nodePath.lastIndexOf('/'));
    const components = JSON.parse(JSON.stringify(node.userData?.realvirtual ?? {})) as Record<string, Record<string, unknown>>;
    delete (components as Record<string, unknown>)['__rvAdded'];
    return {
      parentPath, name: node.name,
      position: [node.position.x, node.position.y, node.position.z],
      quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      scale: [node.scale.x, node.scale.y, node.scale.z],
      components,
    };
  }

  /** Rebuild candidates / ghosts / path visualizer after a structural change. */
  private refresh(): void {
    if (this.viewer && this._lastSnap) this.viewer.emit('selection-changed', this._lastSnap);
  }

  private pickHandle(e: PointerEvent): Handle | null {
    if (!this.gizmo) return null;
    this.gizmo.updateMatrixWorld(true); // ensure latest position/scale before raycast
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, this.viewer!.camera);
    for (const hit of this.raycaster.intersectObject(this.gizmo, true)) {
      const h = hit.object.userData?.gizmoHandle as Handle | undefined;
      if (h) return h;
    }
    return null;
  }

  /** Raycast the robot subtrees and return the RobotIK whose mesh was hit, or null. */
  private pickRobot(e: PointerEvent): RVRobotIK | null {
    const viewer = this.viewer; if (!viewer?.registry) return null;
    const robots = viewer.registry.getAll<RVRobotIK>('RobotIK');
    if (!robots.length) return null;
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const hits = this.raycaster.intersectObjects(robots.map((r) => r.instance.node), true);
    return hits.length ? viewer.registry.findInParent<RVRobotIK>(hits[0].object, 'RobotIK') : null;
  }

  // ── Tool ghosts (one per pathpoint; shown when the path is selected but no point is edited) ──

  private buildGhosts(): void {
    const viewer = this.viewer; if (!viewer) return;
    if (!this.ghostMat) this.ghostMat = new MeshBasicMaterial({ color: 0x33d6ff, transparent: true, opacity: 0.25, depthWrite: false });
    for (const c of this.candidates) {
      const axis6 = c.drives[5]?.node;
      if (!axis6) continue;
      // Solve this waypoint and snapshot the REAL axis-6 world pose → the ghost is
      // oriented exactly like the robot's flange/tool at that target (no frame guessing).
      this.resolve(c);
      axis6.updateWorldMatrix(true, false);
      const clone = axis6.clone(true); // shares geometry refs with the real robot — never dispose it
      clone.position.set(0, 0, 0); clone.quaternion.identity(); clone.scale.set(1, 1, 1);
      clone.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.material = this.ghostMat!; });
      const ghost = new Group(); ghost.name = '__rvIKGhost'; ghost.add(clone);
      axis6.matrixWorld.decompose(ghost.position, ghost.quaternion, ghost.scale);
      ghost.visible = false;
      viewer.scene.add(ghost);
      this.ghosts.set(c, ghost);
    }
    // Leave the robot at the first waypoint (tidy starting pose).
    if (this.candidates[0]) this.resolve(this.candidates[0]);
  }

  private setGhostsVisible(v: boolean): void {
    for (const g of this.ghosts.values()) g.visible = v;
  }

  /** Remove ghost groups from the scene. Geometry is shared with the robot — do NOT dispose it. */
  private clearGhosts(): void {
    if (this.viewer) for (const g of this.ghosts.values()) this.viewer.scene.remove(g);
    this.ghosts.clear();
  }

  // ── Helpers ──

  private withinCanvas(e: PointerEvent): boolean {
    const el = this.viewer?.renderer.domElement; if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private setNdc(e: PointerEvent): void {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private closestOnAxis(axisO: Vector3, axisD: Vector3, rayO: Vector3, rayD: Vector3): number {
    this._v.subVectors(axisO, rayO);
    const b = axisD.dot(rayD), c = rayD.dot(rayD), d = axisD.dot(this._v), e2 = rayD.dot(this._v);
    const denom = c - b * b;
    return denom !== 0 ? (b * e2 - c * d) / denom : 0;
  }

  private signedAngle(a: Vector3, b: Vector3, axis: Vector3): number {
    this._v.crossVectors(a, b);
    return Math.atan2(this._v.dot(axis), a.dot(b));
  }

  private nearestCandidate(e: PointerEvent): Candidate | null {
    const viewer = this.viewer!;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best: Candidate | null = null, bestD = GRAB_RADIUS_PX;
    for (const c of this.candidates) {
      this.worldPos(c.node, this._v).project(viewer.camera);
      if (this._v.z > 1) continue;
      const sx = (this._v.x * 0.5 + 0.5) * r.width, sy = (-this._v.y * 0.5 + 0.5) * r.height;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bestD) { bestD = dd; best = c; }
    }
    return best;
  }

  private disposeObject(root: Object3D): void {
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
  }

  // ── Re-solve and apply ──

  /** Re-solve the robot to the candidate's pose and apply it. Returns true if reachable.
   *  matrixWorld is read directly (robot root may be frozen → updateWorldMatrix corrupts). */
  private resolve(c: Candidate): boolean {
    targetPoseInBase(c.robot.node.matrixWorld, c.node.matrixWorld, this._p3, this._q4);
    const solutions = ikSolverRegistry.solvePieper(c.params, this._p3, this._q4);
    if (!solutions) return false;
    for (let i = 0; i < 6; i++) this._seed[i] = c.drives[i].currentPosition;
    const best = ikSolverRegistry.selectClosest(solutions, this._seed);
    if (!best) return false;
    for (let i = 0; i < 6; i++) { const d = c.drives[i]; d.positionOverwrite = true; d.currentPosition = best[i]; d.applyToNode(); }
    return true;
  }
}
