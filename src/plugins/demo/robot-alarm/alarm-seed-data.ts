// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-seed-data.ts — Static demo data for the FANUC CRX "Ask AI" alarm story.
 *
 * Defines the SYST-320 contact-force alarm scenario shown in the public web demo:
 * the curated diagnosis + recommended steps, the manual deep-link targets, the
 * three seeded operator notes, and the search terms used to locate the real
 * excerpt page inside the bundled FANUC CRX PDF at runtime.
 *
 * The AI answer is intentionally faked (no backend) — the PDF excerpt and the
 * page deep-links are real.
 */

/** A direct page deep-link into the manual. */
export interface AlarmDocRef {
  /** Human-readable label shown in the Sources block. */
  label: string;
  /**
   * Static fallback page (1-based) used when {@link searchTerms} resolves nothing
   * at runtime. Verify against the bundled PDF.
   */
  page: number;
  /** Terms used by `findFirstPageWithText` to resolve the live page. */
  searchTerms: string[];
}

/** A single operator note (seeded or user-added). */
export interface AlarmNote {
  author: string;
  dateLabel: string;
  shift: string;
  text: string;
  /** True for the curated seed notes that ship with the demo. */
  seed?: boolean;
}

/** The full description of one alarm scenario. */
export interface AlarmScenario {
  id: 'SYST-320';
  code: string;
  title: string;
  subtitle: string;
  severity: 'error';
  icon: 'warning';
  timestamp: string;
  /**
   * Hierarchy path of the robot node (so the card can highlight + frame it in 3D).
   * Matches the existing demo robot tile. NOTE: verify live against the GLB.
   */
  componentPath: string;
  /** Same-origin URL of the bundled FANUC CRX manual. */
  manualUrl: string;
  diagnosis: string;
  /** Recommended steps, ordered/weighted by what the operator notes show. */
  recommendedSteps: string[];
  /** Manual deep-link targets shown in the Sources block. */
  docRefs: AlarmDocRef[];
  /** Curated seed notes (shown first in History). */
  seedNotes: AlarmNote[];
  /** Terms used to locate the live excerpt page in the PDF. */
  excerptSearchTerms: string[];
}

/**
 * Robot node path. Matches the existing robot maintenance tile in the demo.
 * NOTE: verify live against the loaded DemoRealvirtualWeb.glb (`scene_find` / `web_*`).
 */
const ROBOT_COMPONENT_PATH = 'A4';

/** Same-origin URL of the bundled FANUC CRX educational-cell manual. */
const FANUC_MANUAL_URL = `${import.meta.env.BASE_URL}pdf/fanuc-crx-educational-cell-manual.pdf`;

/**
 * The SYST-320 scenario.
 *
 * Page numbers in `docRefs` / the default excerpt page are static fallbacks
 * verified against the bundled FANUC CRX educational-cell PDF: "payload" → p.25,
 * "contact stop" → p.11, "dual check safety" → p.14. They are also resolved live
 * at runtime via `findFirstPageWithText`. Re-verify these if the bundled PDF is
 * replaced.
 */
export const SYST_320_SCENARIO: AlarmScenario = {
  id: 'SYST-320',
  code: 'SYST-320',
  title: 'SYST-320 — Contact Force Exceeds Limit',
  subtitle: 'FANUC CRX cobot · DCS contact stop triggered on wrist',
  severity: 'error',
  icon: 'warning',
  timestamp: '08:42',
  componentPath: ROBOT_COMPONENT_PATH,
  manualUrl: FANUC_MANUAL_URL,
  diagnosis:
    "SYST-320 means the cobot's Dual Check Safety (DCS) system measured an external " +
    'contact force above the configured limit and triggered a protective stop. On a CRX ' +
    'this is usually a payload/setup issue rather than a hardware fault — the most common ' +
    'trigger is an incorrect payload setting, followed by cable drag or unintended contact ' +
    'with a fixture or part edge.',
  recommendedSteps: [
    'Clear the contact — remove any object, fixture or part touching the arm; the stop often self-clears once the force is gone.',
    'Verify payload mass and center of gravity, then re-run Payload Estimation. Make sure the PAYLOAD instruction runs AFTER grip confirmation, not before. (most common cause)',
    'Check cable routing / dress-out. A loose or dragging cable is read as external contact — secure and re-route the bundle.',
    'Review the DCS contact-force limit / force threshold for this motion; if the path grazes a part edge, raise the approach height slightly.',
    'Press RESET and watch the next 2–3 cycles for recurrence.',
  ],
  docRefs: [
    {
      label: 'FANUC CRX Cell Manual — Payload / Load setting',
      page: 25,
      searchTerms: ['payload', 'load setting'],
    },
    {
      label: 'FANUC CRX Cell Manual — Contact Stop / DCS',
      page: 11,
      searchTerms: ['contact stop', 'dual check safety', 'dcs'],
    },
  ],
  excerptSearchTerms: ['contact stop', 'dual check safety', 'payload', 'dcs'],
  seedNotes: [
    {
      author: 'Roberto M.',
      dateLabel: '17 Jun',
      shift: 'Day shift',
      seed: true,
      text:
        'Swapped from the suction cup to the magnetic gripper but forgot to update the ' +
        'payload. SYST-320 fired on the very first cycle. Ran Payload Estimation (~5 min) ' +
        'and it cleared. Set the PAYLOAD instruction to run AFTER grip confirmation now.',
    },
    {
      author: 'Anja K.',
      dateLabel: '20 Jun',
      shift: 'Day shift',
      seed: true,
      text:
        'Payload was correct this time. A loose power cable was dragging across the gripper ' +
        'on extension — the cobot read the cable tension as contact. Clipped and re-routed ' +
        'the bundle, no more trips.',
    },
    {
      author: 'Yuki N.',
      dateLabel: '11 Jun',
      shift: 'Night shift',
      seed: true,
      text:
        'Kept tripping during the assembly move. Turned out a part edge (manufacturing ' +
        'tolerance) caused light continuous contact. Raised the approach height by 5 mm and ' +
        'it stopped. No parts damaged.',
    },
  ],
};

/** All scenarios keyed by id (single entry today). */
export const ALARM_SCENARIOS: Record<AlarmScenario['id'], AlarmScenario> = {
  'SYST-320': SYST_320_SCENARIO,
};
