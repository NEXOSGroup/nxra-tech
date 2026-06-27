// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model plugins for the DemoRealvirtualWeb demo scene.
 *
 * Registers all demo-specific HMI plugins (KPIs, messages, controls)
 * and optional feature plugins (WebXR, Multiuser, FPV, Annotations).
 * These are only active when DemoRealvirtualWeb.glb or RealvirtualWebTest.glb is loaded.
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';
import { ModelOptionPlugin, remapAasLink } from '../model-option-plugin';
import { OperatorHmiControlsPlugin } from './operator-hmi-controls';

// Demo HMI plugins
import { KpiDemoPlugin } from '../../demo/kpi-demo-plugin';
import { DemoHMIPlugin } from '../../demo/demo-hmi-plugin';
import { TestAxesPlugin } from '../../demo/test-axes-plugin';
import { MachineControlPlugin } from '../../demo/machine-control-plugin';
import { MaintenancePlugin } from '../../demo/maintenance-plugin';

// Optional feature plugins
import { WebXRPlugin } from '../../webxr-plugin';
import { MultiuserPlugin } from '../../multiuser-plugin';
import { FpvPlugin } from '../../fpv-plugin';
import { AnnotationPlugin } from '../../annotation-plugin';
import { AasLinkPlugin } from '../../aas-link-plugin';
import { OrderManagerPlugin } from '../../order-manager-plugin';

// Kiosk Mode — disabled for now, re-enable when tour content is ready
// import type { KioskPlugin } from '../../kiosk-plugin';
// import { demoKioskTour } from './demo-kiosk-tour';

// Side-effect import: triggers tooltipRegistry self-registration for 'aas' content type
import '../../aas-link-plugin';

// Side-effect import: opt this demo into the live drive HUD tooltip. The
// core HMI no longer side-effect-imports DriveTooltipContent — it's
// optional, per-deployment. Model-plugin packs that want the floating
// "Position / Speed / Target" hover card import it here.
import '../../../core/hmi/tooltip/DriveTooltipContent';

/** The Festo EMME-AS-40 servo motor AAS that ships in the base GLB. */
const FESTO_MOTOR_AAS = 'http://smart.festo.com/aas/99920200617190044000012858';

/**
 * Apply the active supplier option (`?option=`) by issuing rv_extras commands.
 * Each option re-points the Drive 1 motor's AAS to a different supplier — the Festo
 * electric cylinder (a separate AAS) is left untouched. Add more commands per option
 * here (e.g. setComponentField) to manipulate any rv_extras property.
 */
function applyModelOption(viewer: RVViewer, option: string): void {
  if (option === 'bosch') {
    remapAasLink(viewer, FESTO_MOTOR_AAS,
      'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001',
      'Bosch Rexroth ctrlX DRIVE - MS2N Servomotor');
  } else if (option === 'sew') {
    remapAasLink(viewer, FESTO_MOTOR_AAS,
      'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001',
      'SEW KA47-DRN90M4 Gearmotor');
  }
}

/** Model filenames (without .glb) that this module handles. */
export const models = ['DemoRealvirtualWeb', 'RealvirtualWebTest'];

/** Track registered plugin IDs for clean unregister. */
const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  const instances = [
    // Model options (AAS supplier swap) — MUST be first so the remap runs
    // before AasLinkPlugin pre-parses the AASX for the swapped ids.
    new ModelOptionPlugin(applyModelOption),
    // Hide engineering sim controls (Play/Pause/Reset + Realtime/DES) in HMI mode.
    new OperatorHmiControlsPlugin(),
    // Demo HMI
    new KpiDemoPlugin(),
    new DemoHMIPlugin(),
    new TestAxesPlugin(),
    new MachineControlPlugin(),
    new MaintenancePlugin(),
    // Optional features
    new WebXRPlugin(),
    new MultiuserPlugin(),
    new FpvPlugin(),
    new AnnotationPlugin(),
    new AasLinkPlugin(),
    new OrderManagerPlugin(),
  ];
  for (const p of instances) {
    viewer.use(p);
    registeredIds.push(p.id);
  }

  // Kiosk tours — disabled for now, re-enable when tour content is ready
  // const kiosk = viewer.getPlugin<KioskPlugin>('kiosk');
  // if (kiosk) {
  //   for (const modelName of models) {
  //     kiosk.registerTour(modelName, demoKioskTour);
  //   }
  // }
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;

  // const kiosk = viewer.getPlugin<KioskPlugin>('kiosk');
  // if (kiosk) {
  //   for (const modelName of models) {
  //     kiosk.unregisterTour(modelName);
  //   }
  // }
}

export default { models, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
