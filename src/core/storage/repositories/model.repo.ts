import { readJSON, writeJSON } from '../database';
import type { AIModel } from '../../../types';

const FILE = 'models.json';

export const modelRepo = {
  findAll(providerId?: string): AIModel[] {
    const models = readJSON<AIModel[]>(FILE, []);
    return providerId ? models.filter((m) => m.providerId === providerId) : models;
  },

  upsert(model: AIModel): void {
    const models = this.findAll();
    const idx = models.findIndex((m) => m.id === model.id && m.providerId === model.providerId);
    if (idx >= 0) {
      models[idx] = model;
    } else {
      models.push(model);
    }
    writeJSON(FILE, models);
  },

  deleteByProvider(providerId: string): void {
    const models = this.findAll().filter((m) => m.providerId !== providerId);
    writeJSON(FILE, models);
  },

  // Replace a provider's cached models with exactly `models` — so a model removed
  // upstream (or otherwise gone) is pruned from the cache instead of lingering
  // (which is what made deleted models keep showing up, incl. in the phone picker).
  replaceForProvider(providerId: string, models: AIModel[]): void {
    const others = this.findAll().filter((m) => m.providerId !== providerId);
    writeJSON(FILE, [...others, ...models]);
  },
};
