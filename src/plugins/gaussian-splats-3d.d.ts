// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

declare module '@mkkellogg/gaussian-splats-3d' {
  import { Object3D } from 'three';

  interface ViewerOptions {
    gpuAcceleratedSort?: boolean;
    inMemoryCompressionLevel?: number;
    freeIntermediateSplatData?: boolean;
    sharedMemoryForWorkers?: boolean;
    selfDrivenMode?: boolean;
    useBuiltInControls?: boolean;
    /** Host Three.js scene whose opaque meshes are pre-rendered to the
     *  depth buffer before splats — required for correct depth-occlusion
     *  of host geometry inside the splat. */
    threeScene?: Object3D;
    /** When `true`, splat scene transforms can be modified at runtime —
     *  required because we move/rotate splat containers via the planner. */
    dynamicScene?: boolean;
    renderer?: unknown;
    camera?: unknown;
  }

  interface SplatSceneOptions {
    progressiveLoad?: boolean;
    showLoadingUI?: boolean;
    format?: number;
    position?: [number, number, number];
    rotation?: [number, number, number, string];
    scale?: [number, number, number];
  }

  export class Viewer {
    splatMesh: Object3D | null;
    constructor(options?: ViewerOptions);
    addSplatScene(url: string, options?: SplatSceneOptions): Promise<void>;
    removeSplatScene(index: number): void;
    update(): void;
    render(): void;
    dispose(): Promise<void>;
  }

  export class DropInViewer extends Object3D {
    constructor(options?: ViewerOptions);
    addSplatScene(url: string, options?: SplatSceneOptions): Promise<void>;
    removeSplatScene(index: number): void;
    dispose(): Promise<void>;
  }
}
