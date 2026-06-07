// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  chooseDispatchAngle,
  monotonicNext,
  calibrateBeltNeutralAngle,
  alignToInputAngle,
  dispatchToOutputAngle,
} from '../src/behaviors/_shared/turntable-angle-math';

function nodeAt(x: number, y: number, z: number): Object3D {
  const n = new Object3D();
  n.position.set(x, y, z);
  return n;
}

describe('monotonicNext', () => {
  it('returns target itself when last is 0 and target is within ±180', () => {
    expect(monotonicNext(0, 90)).toBe(90);
    expect(monotonicNext(0, -90)).toBe(-90);
    expect(monotonicNext(0, 179)).toBe(179);
  });

  it('shifts target by +360 when it would otherwise reverse past −180°', () => {
    // last=350, naive target=10 (a 340° backward sweep). monotonicNext brings it to 370 (a 20° forward step).
    expect(monotonicNext(350, 10)).toBe(370);
  });

  it('shifts target by −360 when it would otherwise reverse past +180°', () => {
    expect(monotonicNext(-350, -10)).toBe(-370);
  });

  it('accumulates through many full turns without wrapping', () => {
    let φ = 0;
    for (let i = 0; i < 10; i++) φ = monotonicNext(φ, (φ % 360) + 90);
    expect(φ).toBeGreaterThan(800);   // 10 × ~90° forward steps, monotonically increasing
  });
});

describe('chooseDispatchAngle — Y-axis turntable (most common)', () => {
  const Y = new Vector3(0, 1, 0);

  it('with no input snap: target is the output snap angle in the XZ plane', () => {
    // Output snap at +X local: angle = atan2(0, 1) × rad2deg = 0°.
    const out = nodeAt(1, 0, 0);
    expect(chooseDispatchAngle({ driveAxis: Y, inputSnapNode: null, outputSnapNode: out, lastCommandedAngle: 0 }))
      .toBeCloseTo(0, 5);

    // Output snap at +Z local: angle = atan2(1, 0) × rad2deg = 90°.
    const outZ = nodeAt(0, 0, 1);
    expect(chooseDispatchAngle({ driveAxis: Y, inputSnapNode: null, outputSnapNode: outZ, lastCommandedAngle: 0 }))
      .toBeCloseTo(90, 5);
  });

  it('with one input snap: target = θ_out − θ_in − 180°', () => {
    // input at +X (0°), output at +Z (90°) → target = 90 − 0 − 180 = −90.
    const inp = nodeAt(1, 0, 0);
    const out = nodeAt(0, 0, 1);
    expect(chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: out, lastCommandedAngle: 0 }))
      .toBeCloseTo(-90, 5);
  });

  it('4-way turntable from input=+X: each output gets a distinct target', () => {
    const inp = nodeAt(1, 0, 0);
    const outE = nodeAt(0, 0, 1);    // East (+Z): θ_out=90  → target=90−0−180  = −90
    const outW = nodeAt(0, 0, -1);   // West (−Z): θ_out=−90 → target=−90−0−180 = −270
    const outS = nodeAt(-1, 0, 0);   // South (−X): θ_out=180 → target=180−0−180 = 0
    const tE = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: outE, lastCommandedAngle: 0 });
    const tW = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: outW, lastCommandedAngle: 0 });
    const tS = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: outS, lastCommandedAngle: 0 });
    expect(tE).toBeCloseTo(-90, 5);
    expect(tW).toBeCloseTo(90, 5);    // monotonicNext rotates −270 → +90 (shorter)
    expect(tS).toBeCloseTo(0, 5);
  });
});

describe('chooseDispatchAngle — X-axis and Z-axis turntables', () => {
  it('X-axis: snap angles measured in the YZ plane', () => {
    const X = new Vector3(1, 0, 0);
    const out = nodeAt(0, 0, 1);   // (Y=0,Z=1) → atan2(1,0)=90°
    expect(chooseDispatchAngle({ driveAxis: X, inputSnapNode: null, outputSnapNode: out, lastCommandedAngle: 0 }))
      .toBeCloseTo(90, 5);
  });

  it('Z-axis: snap angles measured in the XY plane', () => {
    const Z = new Vector3(0, 0, 1);
    const out = nodeAt(0, 1, 0);   // (X=0,Y=1) → atan2(1,0)=90°
    expect(chooseDispatchAngle({ driveAxis: Z, inputSnapNode: null, outputSnapNode: out, lastCommandedAngle: 0 }))
      .toBeCloseTo(90, 5);
  });
});

describe('belt-relative model (multi-input)', () => {
  const Y = new Vector3(0, 1, 0);

  it('calibrateBeltNeutralAngle: belt plane-angle minus the current drive angle', () => {
    // Belt discharging +X (0°) at drive angle 0 → neutral 0.
    expect(calibrateBeltNeutralAngle(Y, new Vector3(1, 0, 0), 0)).toBeCloseTo(0, 5);
    // Belt discharging +Z (90°) while the drive is physically at 30° → neutral 60°.
    expect(calibrateBeltNeutralAngle(Y, new Vector3(0, 0, 1), 30)).toBeCloseTo(60, 5);
  });

  it('alignToInputAngle: belt must discharge AWAY (θ_in + 180) so its intake faces the input', () => {
    const inX = nodeAt(1, 0, 0);   // θ_in = 0°
    expect(alignToInputAngle(Y, 0, inX, 0)).toBeCloseTo(180, 5);
    // With a non-zero belt neutral the alignment shifts by −neutral.
    expect(alignToInputAngle(Y, 90, inX, 0)).toBeCloseTo(90, 5);   // monotonicNext(0, 180−90)
  });

  it('dispatchToOutputAngle: belt discharges toward the output', () => {
    const outZ = nodeAt(0, 0, 1);  // θ_out = 90°
    expect(dispatchToOutputAngle(Y, 0, outZ, 0)).toBeCloseTo(90, 5);
    expect(dispatchToOutputAngle(Y, 30, outZ, 0)).toBeCloseTo(60, 5);  // 90 − 30
  });

  it('reduces to the legacy dispatch formula when beltNeutral = θ_in + 180', () => {
    // input +X (0°) → beltNeutral = 180. dispatch to +Z (90°): 90 − 180 = −90,
    // matching chooseDispatchAngle({inputSnapNode:+X, outputSnapNode:+Z}) = −90.
    const inX = nodeAt(1, 0, 0);
    const outZ = nodeAt(0, 0, 1);
    const beltNeutral = 180;
    const viaNew = dispatchToOutputAngle(Y, beltNeutral, outZ, 0);
    const viaLegacy = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inX, outputSnapNode: outZ, lastCommandedAngle: 0 });
    expect(viaNew).toBeCloseTo(viaLegacy, 5);
    expect(viaNew).toBeCloseTo(-90, 5);
  });
});

describe('chooseDispatchAngle — monotonic accumulation', () => {
  it('subsequent dispatches keep the platform rotating forward instead of jumping backward', () => {
    const Y = new Vector3(0, 1, 0);
    const inp = nodeAt(1, 0, 0);
    const out90  = nodeAt(0, 0, 1);    // θ_target naive = −90
    const out180 = nodeAt(-1, 0, 0);   // θ_target naive = 0

    const a = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: out90, lastCommandedAngle: 0 });
    expect(a).toBeCloseTo(-90, 5);

    // From last=-90, requesting θ_target=0 again — monotonic should leave it AT 0 (a +90 sweep).
    const b = chooseDispatchAngle({ driveAxis: Y, inputSnapNode: inp, outputSnapNode: out180, lastCommandedAngle: a });
    expect(b).toBeCloseTo(0, 5);
  });
});
