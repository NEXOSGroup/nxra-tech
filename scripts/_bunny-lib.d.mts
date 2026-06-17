// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_bunny-lib.mjs` so the Node test suite type-checks
 * without enabling `allowJs`. Keep in sync with the runtime exports.
 */

export const ALWAYS_UPLOAD_FILES: Set<string>;

export function normalizePath(path: string): string;
export function buildUploadUrl(region: string, storageZone: string, relativePath: string): string;
export function normalizeRegion(region: string | undefined | null): string;
export function mimeType(filePath: string): string;
export function isAlwaysUploadFile(filePath: string): boolean;

export interface BunnyConfig {
  storageKey: string;
  storageZone: string;
  accountKey: string;
  pullZoneId: string;
  region: string;
  remotePath: string;
  googleAnalyticsId: string;
}
export function loadConfig(env?: Record<string, string | undefined>): BunnyConfig;

export type BuildMode = 'public' | 'private';
export function buildEnvForMode(
  mode: BuildMode,
  opts?: { base?: string | null },
): Record<string, string | undefined>;

export function sanitizeDemoName(name: string | null | undefined): string;

export interface LocalFile { abs: string; rel: string; size: number; }
export function collectLocalFiles(rootDir: string): LocalFile[];

export interface DiffFile { rel: string; size: number; }
export function selectFilesToUpload<T extends DiffFile>(
  local: T[],
  remote: Map<string, number> | null,
  opts?: { force?: boolean },
): T[];

export interface RemoteEntry { rel: string; size: number; isDirectory: boolean; }
export function buildRemoteIndex(entries: RemoteEntry[]): Map<string, number>;

export interface BunnyClientOptions {
  region: string;
  zone: string;
  storageKey: string;
  accountKey?: string;
  pullZoneId?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}
export class BunnyClient {
  constructor(opts: BunnyClientOptions);
  putFile(bytes: Uint8Array | Buffer, remotePath: string, mimeOverride?: string): Promise<void>;
  listRecursive(remoteRoot: string): Promise<RemoteEntry[]>;
  purge(): Promise<boolean>;
}

export interface PrivateProject {
  name: string;
  code: string;
  created?: string;
  lastPublished?: string;
  settings?: { defaultModel?: string };
  folderName?: string;
}
export function loadProject(projectDir: string): PrivateProject;
export function discoverPrivateProjects(
  baseDir: string,
): Array<{ project: PrivateProject; projectDir: string; folderName: string }>;

export function generatePrivateSettings(
  project: PrivateProject,
  projectFolderName?: string,
  opts?: { googleAnalyticsId?: string },
): string;

export function stagePrivateProject(opts: {
  distDir: string;
  projectDir: string;
  googleAnalyticsId?: string;
}): string;
