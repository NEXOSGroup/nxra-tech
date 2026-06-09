/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Plan 194 P1 feature flag — opt-in to the unified SimulationKernel /
   * ContinuousRunner path. Default OFF: the legacy fixedUpdate orchestration
   * runs unchanged. Set `VITE_UNIFIED_SIM=1` to route the tick through the
   * kernel (additive, A/B-safe). Removed when the default flips in P6.
   */
  readonly VITE_UNIFIED_SIM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** True when the private sibling folder (realvirtual-WebViewer-Private~) is present at build time. */
declare const __RV_HAS_PRIVATE__: boolean;

/** True when building with RV_COMMERCIAL=1 env var. Hides AGPL watermark. */
declare const __RV_COMMERCIAL__: boolean;
