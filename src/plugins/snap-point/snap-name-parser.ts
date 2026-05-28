// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-Point naming convention parser.
 *
 * Convention: Snap-<AXIS><FLOW>-<TYPEID>
 *
 *   AXIS = X | Y | Z          (cardinal axis of the snap's outward direction)
 *   FLOW = N | P | B          (flow semantics encoded in the sign letter)
 *     N = INPUT  (negative-side / inbound)
 *     P = OUTPUT (positive-side / outbound)
 *     B = BIDI   (either direction)
 *   TYPEID = arbitrary string; may contain hyphens
 *
 * Examples:
 *   Snap-ZN-convroll    Z-axis input  (default: -Z position)
 *   Snap-ZP-convroll    Z-axis output (default: +Z position)
 *   Snap-ZB-convroll    Z-axis bidi   (Turntable-style: position from Empty)
 *   Snap-XB-flange-1    X-axis bidi, typeId 'flange-1'
 *
 * Compatibility (matcher):
 *   1. typeIds must be equal,
 *   2. flows must be compatible: in↔out, bidi↔anything. in↔in / out↔out are
 *      REJECTED (two inputs or two outputs would clash).
 *
 * Outward direction (alignment math): derived from the snap's POSITION inside
 * its owning asset, NOT from the name sign. See `snap-alignment.ts`. The name
 * sign-letter is reserved exclusively for flow semantics.
 */

/** Axis component of a snap direction. */
export type SnapAxis = 'X' | 'Y' | 'Z';

/** Sign letter — N/P/B map to flow. */
export type SnapSign = 'N' | 'P' | 'B';

/** Combined direction code as it appears in GLB names. */
export type SnapDirectionCode =
  | 'XN' | 'XP' | 'XB'
  | 'YN' | 'YP' | 'YB'
  | 'ZN' | 'ZP' | 'ZB';

export interface SnapDirection {
  axis: SnapAxis;
  sign: SnapSign;
  code: SnapDirectionCode;
}

/** Flow semantics of a snap: input port, output port, or bidirectional. */
export type SnapFlow = 'in' | 'out' | 'bidi';

/** Map the sign letter to flow semantics. */
export function flowFromSign(sign: SnapSign): SnapFlow {
  if (sign === 'N') return 'in';
  if (sign === 'P') return 'out';
  return 'bidi';
}

/** Greedy match on the TypeId so `Snap-XN-conv-roll` -> typeId = 'conv-roll'. */
const SNAP_NAME_RE = /^Snap-(XN|XP|XB|YN|YP|YB|ZN|ZP|ZB)-(.+)$/;

/** Parse a node name. Returns null if it doesn't match the convention. */
export function parseSnapName(
  name: string,
): { dir: SnapDirection; typeId: string; flow: SnapFlow } | null {
  if (!name) return null;
  const m = SNAP_NAME_RE.exec(name);
  if (!m) return null;
  const dirCode = m[1] as SnapDirectionCode;
  const typeId = m[2];
  if (!typeId) return null;
  const sign = dirCode[1] as SnapSign;
  return {
    dir: {
      axis: dirCode[0] as SnapAxis,
      sign,
      code: dirCode,
    },
    typeId,
    flow: flowFromSign(sign),
  };
}

/** Opposite direction code along the same axis (legacy helper — kept for
 *  source-compat with callers that still query it; new code should rely on
 *  position-based outward + flow-based compatibility instead). */
export function oppositeDirection(d: SnapDirection): SnapDirectionCode {
  // For a bidi snap, "opposite" is undefined — fall back to itself.
  if (d.sign === 'B') return d.code;
  const flipped: SnapSign = d.sign === 'N' ? 'P' : 'N';
  return `${d.axis}${flipped}` as SnapDirectionCode;
}

/** Are two flows allowed to mate?
 *   in  ↔ out         ✓
 *   in  ↔ in          ✗
 *   out ↔ out         ✗
 *   bidi ↔ anything   ✓
 *   undefined treated as bidi (legacy / partial data).
 */
export function flowsCompatible(a: SnapFlow | undefined, b: SnapFlow | undefined): boolean {
  const fa = a ?? 'bidi';
  const fb = b ?? 'bidi';
  if (fa === 'bidi' || fb === 'bidi') return true;
  return (fa === 'in' && fb === 'out') || (fa === 'out' && fb === 'in');
}
