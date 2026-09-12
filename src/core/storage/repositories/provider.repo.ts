import { readJSON, writeJSON } from '../database';
import type { ProviderConfig } from '../../../types';
import { v4 as uuidv4 } from 'uuid';

const FILE = 'providers.json';

export const providerRepo = {
  findAll(): ProviderConfig[] {
    return readJSON<ProviderConfig[]>(FILE, []);
  },

  findById(id: string): ProviderConfig | null {
    return this.findAll().find((p) => p.id === id) || null;
  },

  create(config: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): ProviderConfig {
    const providers = this.findAll();
    const now = Date.now();
    const provider: ProviderConfig = { ...config, id: uuidv4(), createdAt: now, updatedAt: now };
    providers.push(provider);
    writeJSON(FILE, providers);
    return provider;
  },

  update(id: string, config: Partial<ProviderConfig>): ProviderConfig | null {
    const providers = this.findAll();
    const idx = providers.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    providers[idx] = { ...providers[idx], ...config, updatedAt: Date.now() };
    writeJSON(FILE, providers);
    return providers[idx];
  },

  delete(id: string): boolean {
    const providers = this.findAll();
    const filtered = providers.filter((p) => p.id !== id);
    if (filtered.length === providers.length) return false;
    writeJSON(FILE, filtered);
    return true;
  },
};
