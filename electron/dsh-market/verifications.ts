import fs from 'node:fs';
import path from 'node:path';
import { DSH_COMPAT_LAYER_VERSION, type DshRuntimeEnvironment, type PluginVerification } from '../../src/core/dsh-market/types';

export interface VerificationFile {
  format: 'conecode-dsh-verifications';
  formatVersion: 1;
  records: PluginVerification[];
}

export function currentEnvironment(versions?: { app?: string; electron?: string; chrome?: string }): DshRuntimeEnvironment {
  return {
    appVersion: versions?.app || process.env.npm_package_version || 'dev',
    electronVersion: versions?.electron || process.versions.electron || 'unknown',
    nodeVersion: process.versions.node,
    ...(versions?.chrome || process.versions.chrome ? { chromeVersion: versions?.chrome || process.versions.chrome } : {}),
    platform: process.platform,
    arch: process.arch,
  };
}

export function loadVerifications(filename: string): Record<string, PluginVerification> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as VerificationFile;
    if (parsed.format !== 'conecode-dsh-verifications' || parsed.formatVersion !== 1 || !Array.isArray(parsed.records)) {
      return {};
    }
    const out: Record<string, PluginVerification> = {};
    for (const record of parsed.records) {
      if (!record || typeof record.name !== 'string' || typeof record.version !== 'string') continue;
      if (record.baselineCommit === undefined || record.layerVersion === undefined) continue;
      out[`${record.name}@${record.version}`] = record;
    }
    return out;
  } catch {
    return {};
  }
}

export function verificationFileCandidates(appPath: string): string[] {
  return [
    path.join(appPath, 'resources', 'dsh-market', 'verifications.json'),
    path.join(process.resourcesPath || '', 'dsh-market', 'verifications.json'),
    path.join(appPath, 'dsh-market', 'verifications.json'),
    path.join(process.cwd(), 'resources', 'dsh-market', 'verifications.json'),
  ];
}

export function loadVerificationRecords(appPath: string): Record<string, PluginVerification> {
  for (const candidate of verificationFileCandidates(appPath)) {
    if (fs.existsSync(candidate)) {
      const records = loadVerifications(candidate);
      if (Object.keys(records).length) return records;
    }
  }
  return {};
}

export const VERIFICATION_LAYER_VERSION = DSH_COMPAT_LAYER_VERSION;
