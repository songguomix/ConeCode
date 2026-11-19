import { gptDetector, type GptDetectionResult } from '../core/constraints/gptDetector';
import type { ConstraintSessionStatus } from '../core/constraints/gptSessionState';
import { useProviderStore } from './provider.store';

interface Selection {
  providerId: string;
  modelId: string;
  explicit: boolean;
  pending: boolean;
  status: ConstraintSessionStatus;
}

let selection: Selection | undefined;

function baseUrl(providerId: string) {
  return useProviderStore.getState().providers.find(provider => provider.id === providerId)?.baseUrl;
}

// A selection owns its consent. Replacing this object also invalidates any
// native dialog that is still open, including when switching A → B → A.
export function resetGptConstraintChoice(providerId: string | null, modelId: string | null) {
  selection = providerId && modelId
    ? { providerId, modelId, explicit: false, pending: false, status: 'UNASKED' }
    : undefined;
}

export function getGptConstraintStatus(providerId: string, modelId: string): ConstraintSessionStatus {
  return selection?.providerId === providerId && selection.modelId === modelId ? selection.status : 'UNASKED';
}

async function confirmSelection(current: Selection) {
  if (!current.explicit || current.pending || current.status !== 'UNASKED') return;
  if (!gptDetector.detect(current.modelId, baseUrl(current.providerId)).isGpt) return;
  current.pending = true;
  try {
    const answer = await window.electronAPI.app.confirmGptConstraints(current.modelId);
    if (selection === current) {
      if (answer === 'cancel') current.explicit = false;
      else current.status = answer === 'enable' ? 'ENABLED' : 'DECLINED';
    }
  } catch (error) {
    console.error('Unable to open GPT constraint dialog', error);
    current.explicit = false;
  } finally {
    current.pending = false;
  }
}

export function confirmPickedGptModel(providerId: string, modelId: string) {
  if (selection?.providerId !== providerId || selection.modelId !== modelId) return;
  selection.explicit = true;
  void confirmSelection(selection);
}

export function learnGptConstraintAlias(providerId: string, modelId: string, probe: GptDetectionResult) {
  if (!probe.isGpt || probe.rawModel !== modelId) return;
  const url = baseUrl(providerId);
  gptDetector.recordAlias(url, modelId, probe.fingerprint, probe.normalizedModel);
  if (selection?.providerId === providerId && selection.modelId === modelId) {
    void confirmSelection(selection);
  }
}
