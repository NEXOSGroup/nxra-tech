// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-gpu-info — Diagnostic GPU detection for the WebViewer.
 *
 * Tells us which GPU is currently rendering (vendor + device strings)
 * and, best-effort, which other GPUs the browser exposes — useful for
 * confirming that the page hasn't silently fallen back to integrated
 * graphics on a hybrid laptop.
 *
 * Browser limitations:
 *  - The Web platform deliberately doesn't enumerate physical adapters.
 *    The closest we can do is request an adapter twice with different
 *    `powerPreference` hints; if the strings differ the system has at
 *    least two GPUs.
 *  - Firefox sanitises `WEBGL_debug_renderer_info` to a generic string
 *    in default settings. We surface whatever the browser hands back —
 *    no special-casing.
 */

export type GPUBackend = 'webgl' | 'webgpu';

export interface ActiveGPU {
  vendor: string;
  /** Device / GPU model string. For WebGL this comes from
   *  `UNMASKED_RENDERER_WEBGL`; for WebGPU it's `adapter.info.device`
   *  (falling back to `description`). */
  renderer: string;
  /** WebGPU only: e.g. 'amdgpu-rdna3', 'apple-mxx'. */
  architecture?: string;
}

export interface AdapterSummary {
  vendor: string;
  device: string;
}

export interface GPUInfo {
  backend: GPUBackend;
  active: ActiveGPU;
  /** Populated asynchronously after `enumerateOtherAdapters` resolves —
   *  may stay undefined if WebGPU is unavailable or the browser exposes
   *  only a single adapter. */
  highPerf?: AdapterSummary;
  lowPower?: AdapterSummary;
}

// ── Active-GPU detection (sync) ──────────────────────────────────────

/** Read GPU vendor/renderer from a Three.js renderer. Synchronous: assumes
 *  WebGPU's `await renderer.init()` has already completed if backend is
 *  'webgpu'. Never throws — falls back to `'unknown'` strings. */
export function detectActiveGPU(renderer: unknown, backend: GPUBackend): ActiveGPU {
  try {
    if (backend === 'webgpu') return _detectFromWebGPU(renderer);
    return _detectFromWebGL(renderer);
  } catch {
    return { vendor: 'unknown', renderer: 'unknown' };
  }
}

function _detectFromWebGL(renderer: unknown): ActiveGPU {
  const ctxFn = (renderer as { getContext?: () => unknown })?.getContext;
  if (typeof ctxFn !== 'function') return { vendor: 'unknown', renderer: 'unknown' };
  const gl = ctxFn.call(renderer) as WebGLRenderingContext | WebGL2RenderingContext | null;
  if (!gl || typeof gl.getExtension !== 'function') return { vendor: 'unknown', renderer: 'unknown' };

  const ext = gl.getExtension('WEBGL_debug_renderer_info') as
    | { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number }
    | null;
  if (!ext) {
    // Extension blocked (Firefox strict / privacy mode) — return the
    // generic VENDOR/RENDERER strings, which are at least non-empty.
    return {
      vendor: String(gl.getParameter(gl.VENDOR) ?? 'unknown'),
      renderer: String(gl.getParameter(gl.RENDERER) ?? 'unknown'),
    };
  }
  return {
    vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? 'unknown'),
    renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? 'unknown'),
  };
}

interface MaybeAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

function _detectFromWebGPU(renderer: unknown): ActiveGPU {
  // three/webgpu's `WebGPURenderer.backend` is private API but stable
  // enough across r167+ to cast through.
  const backend = (renderer as { backend?: { adapter?: { info?: MaybeAdapterInfo } } }).backend;
  const info = backend?.adapter?.info;
  if (!info) return { vendor: 'unknown', renderer: 'unknown' };
  return {
    vendor: info.vendor || 'unknown',
    renderer: info.device || info.description || 'unknown',
    architecture: info.architecture || undefined,
  };
}

// ── Other-adapters detection (async, best-effort) ───────────────────

/**
 * Probe the browser for additional adapters by requesting one with
 * each `powerPreference`. If both responses match the active GPU, the
 * caller should leave the optional fields undefined (single-GPU box).
 *
 * Always resolves — never rejects, never throws.
 */
export async function enumerateOtherAdapters(): Promise<{
  highPerf?: AdapterSummary;
  lowPower?: AdapterSummary;
}> {
  // navigator.gpu may be undefined (Safari < 18, no WebGPU support).
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: (opts?: unknown) => Promise<unknown> } }).gpu;
  if (!gpu?.requestAdapter) return {};

  const fetch = async (preference: 'high-performance' | 'low-power'): Promise<AdapterSummary | undefined> => {
    try {
      const adapter = await gpu.requestAdapter!({ powerPreference: preference });
      if (!adapter) return undefined;
      const info = await _readAdapterInfo(adapter);
      if (!info) return undefined;
      const device = (info.device || info.description || '').trim();
      // Chromium often returns empty / redacted device strings for
      // privacy reasons. Without a real device name there is nothing
      // useful to show — drop the entry rather than render
      // "nvidia unknown" alongside the precise WebGL renderer line.
      if (!device) return undefined;
      return { vendor: (info.vendor || 'unknown').trim(), device };
    } catch {
      return undefined;
    }
  };

  const [highPerf, lowPower] = await Promise.all([fetch('high-performance'), fetch('low-power')]);
  return { highPerf, lowPower };
}

/** Read `adapter.info` (Chromium 130+) or fall back to the now-deprecated
 *  `requestAdapterInfo()` on older builds. Returns null on any failure. */
async function _readAdapterInfo(adapter: unknown): Promise<MaybeAdapterInfo | null> {
  const a = adapter as { info?: MaybeAdapterInfo; requestAdapterInfo?: () => Promise<MaybeAdapterInfo> };
  if (a.info) return a.info;
  if (typeof a.requestAdapterInfo === 'function') {
    try { return await a.requestAdapterInfo(); } catch { return null; }
  }
  return null;
}

// ── Equality helper for de-duplicating adapters in the UI ────────────

/** True if a probed adapter is effectively the same as the active GPU,
 *  in which case the UI should hide it (keeps single-GPU machines tidy). */
export function isSameAsActive(probed: AdapterSummary | undefined, active: ActiveGPU): boolean {
  if (!probed) return true;
  // Vendor strings often differ between WebGL (e.g. "ANGLE") and WebGPU
  // (e.g. "nvidia"), so match on device substring rather than equality.
  const a = active.renderer.toLowerCase();
  const p = probed.device.toLowerCase();
  return a.includes(p) || p.includes(a);
}

// ── Tier classification + diagnosis ──────────────────────────────────
//
// Patterns are matched against the GPU's renderer string (which on
// modern Chromium is wrapped in `ANGLE (vendor, device, driver)` so a
// substring match is the right approach). Order matters: the first
// pattern that matches wins, and we run the more specific groups
// (software, apple-silicon, discrete) BEFORE the broader integrated
// patterns to avoid false positives.

/** Software / CPU rendering — performance is so low this is always
 *  worth flagging as critical. Common when hardware acceleration is
 *  disabled in the browser, the system has no working GPU driver, or
 *  the page was opened in a sandboxed context. */
const PATTERN_SOFTWARE = /SwiftShader|llvmpipe|Microsoft Basic Render Driver|Mesa.*softpipe|ANGLE.*Software|Software Rasterizer/i;

/** Apple Silicon — integrated SoC GPU but high enough perf that we
 *  treat it as discrete-class for diagnostic purposes. M1/M2/M3/M4
 *  variants and the Pro / Max / Ultra flavours all match. */
const PATTERN_APPLE = /\bApple M\d/i;

/** Dedicated GPUs from any vendor. Includes Intel Arc (technically
 *  discrete despite the brand). Order before integrated so e.g.
 *  "AMD Radeon RX 6700 XT" doesn't slip into the AMD-integrated
 *  bucket below. */
const PATTERN_DISCRETE = /\bNVIDIA\b|\bGeForce\b|\bQuadro\b|\bRTX\b|\bGTX\b|AMD.*Radeon (?:RX|Pro)|\bRadeon Pro\b|Intel.*\bArc\b/i;

/** Integrated GPUs — Intel iGPU families (HD/UHD/Iris/Xe), AMD APU
 *  graphics (Vega 3-11, Radeon 680M/780M and "Radeon Graphics" with
 *  no model number), and the common mobile chips. */
const PATTERN_INTEGRATED = /Intel.*(?:HD Graphics|UHD Graphics|Iris)|AMD.*(?:Vega \d|Radeon (?:6|7|8)\d{2}M|Radeon Graphics)|\bAdreno\b|\bMali\b|\bPowerVR\b/i;

export type GPUTier = 'software' | 'integrated' | 'discrete' | 'apple-silicon' | 'unknown';
export type GPUSeverity = 'ok' | 'warning' | 'critical';

export interface GPUAnalysis {
  /** Performance class of the active GPU. */
  tier: GPUTier;
  /** ok = nothing to flag; warning = working but suboptimal (e.g.
   *  integrated when discrete is available); critical = software
   *  fallback, the page is rendering on the CPU. */
  severity: GPUSeverity;
  /** True iff a WebGPU adapter probe confirmed a discrete adapter
   *  exists that's NOT the one we're using. High-confidence signal. */
  discreteAvailableConfirmed: boolean;
  /** Best-effort vendor/device of the better adapter, when known. */
  betterAvailable?: string;
  /** Short summary of the issue. Empty when severity === 'ok'. */
  message?: string;
  /** Suggested user-facing remediation, separate so the UI can render
   *  it differently from the message (e.g. as a smaller second line). */
  action?: string;
}

/** Classify a GPU renderer string into a performance tier. Pure
 *  function; no side effects. Returns 'unknown' when no pattern
 *  matches — better to be quiet than to mis-classify on a string we
 *  haven't seen before. */
export function classifyGPU(active: ActiveGPU): GPUTier {
  const s = active.renderer ?? '';
  if (!s || s === 'unknown') return 'unknown';
  // ORDER MATTERS — see comment above the patterns.
  if (PATTERN_SOFTWARE.test(s)) return 'software';
  if (PATTERN_APPLE.test(s)) return 'apple-silicon';
  if (PATTERN_DISCRETE.test(s)) return 'discrete';
  if (PATTERN_INTEGRATED.test(s)) return 'integrated';
  return 'unknown';
}

/** Same classification but applied to a probed adapter summary
 *  (vendor + device, no architecture). Used to decide whether a probe
 *  result represents a discrete option we're missing out on. */
export function classifyAdapter(adapter: AdapterSummary): GPUTier {
  // Combine vendor + device — vendor "nvidia" alone is a strong signal
  // even when device is empty (Chromium privacy redaction).
  const s = `${adapter.vendor} ${adapter.device}`;
  if (PATTERN_SOFTWARE.test(s)) return 'software';
  if (PATTERN_APPLE.test(s)) return 'apple-silicon';
  if (PATTERN_DISCRETE.test(s)) return 'discrete';
  if (/^nvidia\b/i.test(adapter.vendor)) return 'discrete'; // bare-vendor case
  if (PATTERN_INTEGRATED.test(s)) return 'integrated';
  if (/^intel\b/i.test(adapter.vendor)) return 'integrated';
  return 'unknown';
}

/** Combine the tier classification with the WebGPU probe results to
 *  produce a single, actionable diagnosis. */
export function analyzeGPU(info: GPUInfo): GPUAnalysis {
  const tier = classifyGPU(info.active);

  // Software fallback is critical regardless of any other signal — the
  // page is rendering on the CPU and there's no realistic recovery.
  if (tier === 'software') {
    return {
      tier,
      severity: 'critical',
      discreteAvailableConfirmed: false,
      message: 'Hardware acceleration is disabled — rendering on the CPU.',
      action: 'Enable hardware acceleration in your browser settings, or update your graphics driver.',
    };
  }

  // Did a WebGPU probe find a discrete adapter that ISN'T the one we
  // ended up using? That's the high-confidence "wrong GPU" signal.
  const probes: AdapterSummary[] = [];
  if (info.highPerf) probes.push(info.highPerf);
  if (info.lowPower) probes.push(info.lowPower);
  let discreteProbe: AdapterSummary | undefined;
  for (const p of probes) {
    const probedTier = classifyAdapter(p);
    if ((probedTier === 'discrete' || probedTier === 'apple-silicon')
        && !isSameAsActive(p, info.active)) {
      discreteProbe = p;
      break;
    }
  }

  // Integrated active GPU is suboptimal; whether to call it out
  // strongly depends on whether we can confirm a better option exists.
  if (tier === 'integrated') {
    if (discreteProbe) {
      const betterName = `${discreteProbe.vendor} ${discreteProbe.device}`.trim();
      return {
        tier,
        severity: 'warning',
        discreteAvailableConfirmed: true,
        betterAvailable: betterName,
        message: `Browser is using integrated graphics — ${betterName} is available but not being used.`,
        action: 'Windows: Settings → System → Display → Graphics → set this browser to "High performance".',
      };
    }
    // Integrated detected, no probe data confirming a better option.
    // Could still be wrong (Edge often hides the discrete adapter
    // entirely from WebGPU enumeration) — soft warning that's
    // actionable without being alarmist.
    return {
      tier,
      severity: 'warning',
      discreteAvailableConfirmed: false,
      message: 'Browser is using integrated graphics. If this device has a dedicated GPU, performance will improve substantially by switching to it.',
      action: 'Windows: Settings → System → Display → Graphics → set this browser to "High performance".',
    };
  }

  // Discrete or Apple Silicon → all good.
  if (tier === 'discrete' || tier === 'apple-silicon') {
    return { tier, severity: 'ok', discreteAvailableConfirmed: false };
  }

  // Unknown renderer string — don't fabricate a warning. Stay quiet
  // and let the GPU-info display surface the raw string for debugging.
  return { tier: 'unknown', severity: 'ok', discreteAvailableConfirmed: false };
}
