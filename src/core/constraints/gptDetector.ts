import type { DetectionSource } from './gptSessionState';

export interface GptDetectionResult {
  isGpt: boolean;
  rawModel: string;
  normalizedModel: string;
  isReasoningSeries: boolean;
  source: DetectionSource;
  matchedPattern?: string;
  fingerprint?: string;
}

export interface AliasCacheEntry {
  baseUrl: string;
  modelAlias: string;
  fingerprint?: string;
  detectedModel?: string;
  recordedAt: number;
}

export interface ResponseProbeInput {
  baseUrl?: string;
  modelAlias: string;
  headers?: Headers | Record<string, string | string[] | undefined> | null;
  body?: unknown;
}

const VENDOR_PREFIX_RE = /^(?:openai|azure|azure-openai|openrouter|github|together|bedrock|vertex|litellm|custom)\//i;
const REASONING_SERIES_RE = /(?:^|[^a-z0-9])(o1|o3|o4)(?:-[a-z0-9._-]+)?(?:$|[^a-z0-9])/i;
const EXPLICIT_GPT_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'gpt', regex: /(?:^|[^a-z0-9])gpt(?:-(?:\d|oss|turbo|omni|mini|nano|pro)[a-z0-9._-]*)?(?:$|[^a-z0-9-])/i },
  { name: 'chatgpt', regex: /(?:^|[^a-z0-9])chatgpt(?:-[a-z0-9._-]+)?(?:$|[^a-z0-9-])/i },
  { name: 'o-series', regex: REASONING_SERIES_RE },
];

const SYSTEM_FINGERPRINT_RE = /^fp_[a-zA-Z0-9]+/;
const OPENAI_HEADER_KEYS = [
  'openai-model',
  'openai-processing-ms',
  'openai-organization',
  'openai-version',
] as const;

function normalizeBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return '';
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeModelAlias(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function readHeader(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  targetName: string,
): string | undefined {
  if (!headers) return undefined;
  const lowerTarget = targetName.toLowerCase();
  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(lowerTarget);
    return val ?? undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerTarget) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

/**
 * Multi-dimensional GPT / OpenAI model detector:
 * 1. Explicit model name matching (case-insensitive, vendor-prefix stripping).
 * 2. Passive response probing (system_fingerprint `^fp_[a-zA-Z0-9]+` & OpenAI headers).
 * 3. `(base_url, model_alias)` alias cache for proxied/renamed models.
 */
export class GptDetector {
  private readonly aliasCache = new Map<string, AliasCacheEntry>();

  stripVendorPrefix(modelName: string): string {
    let current = (modelName || '').trim();
    while (VENDOR_PREFIX_RE.test(current)) {
      current = current.replace(VENDOR_PREFIX_RE, '');
    }
    return current;
  }

  isReasoningSeriesModel(modelName: string): boolean {
    const stripped = this.stripVendorPrefix(modelName).toLowerCase();
    return REASONING_SERIES_RE.test(stripped);
  }

  detect(modelName: string, baseUrl?: string): GptDetectionResult {
    const rawModel = (modelName || '').trim();
    const stripped = this.stripVendorPrefix(rawModel);
    const lower = stripped.toLowerCase();

    for (const { name, regex } of EXPLICIT_GPT_PATTERNS) {
      if (regex.test(lower)) {
        return {
          isGpt: true,
          rawModel,
          normalizedModel: stripped,
          isReasoningSeries: this.isReasoningSeriesModel(stripped),
          source: 'model_name',
          matchedPattern: name,
        };
      }
    }

    const cacheKey = this.makeAliasKey(baseUrl, rawModel);
    const cached = this.aliasCache.get(cacheKey);
    if (cached) {
      const effectiveModel = cached.detectedModel || stripped;
      return {
        isGpt: true,
        rawModel,
        normalizedModel: effectiveModel,
        isReasoningSeries: this.isReasoningSeriesModel(effectiveModel),
        source: 'alias_cache',
        fingerprint: cached.fingerprint,
      };
    }

    return {
      isGpt: false,
      rawModel,
      normalizedModel: stripped,
      isReasoningSeries: false,
      source: 'none',
    };
  }

  probeResponse(input: ResponseProbeInput): GptDetectionResult {
    const rawModel = (input.modelAlias || '').trim();
    const stripped = this.stripVendorPrefix(rawModel);

    // 1. Check response body for system_fingerprint (`^fp_[a-zA-Z0-9]+`)
    const bodyObj = input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : null;
    const rawFingerprint = typeof bodyObj?.system_fingerprint === 'string' ? bodyObj.system_fingerprint.trim() : '';
    const bodyModel = typeof bodyObj?.model === 'string' ? bodyObj.model.trim() : '';

    if (rawFingerprint && SYSTEM_FINGERPRINT_RE.test(rawFingerprint)) {
      this.recordAlias(input.baseUrl, rawModel, rawFingerprint, bodyModel || undefined);
      const effectiveModel = bodyModel || stripped;
      return {
        isGpt: true,
        rawModel,
        normalizedModel: effectiveModel,
        isReasoningSeries: this.isReasoningSeriesModel(effectiveModel),
        source: 'response_fingerprint',
        fingerprint: rawFingerprint,
      };
    }

    // 2. Check OpenAI characteristic response headers (`openai-model`, `openai-processing-ms`, etc.)
    const openaiModelHeader = readHeader(input.headers, 'openai-model');
    const hasOpenAiHeader = OPENAI_HEADER_KEYS.some((key) => {
      const val = readHeader(input.headers, key);
      return typeof val === 'string' && val.trim().length > 0;
    });

    if (hasOpenAiHeader) {
      const effectiveModel = openaiModelHeader?.trim() || bodyModel || stripped;
      this.recordAlias(input.baseUrl, rawModel, undefined, effectiveModel);
      return {
        isGpt: true,
        rawModel,
        normalizedModel: effectiveModel,
        isReasoningSeries: this.isReasoningSeriesModel(effectiveModel),
        source: 'response_header',
      };
    }

    // 3. Fallback: if response body `model` itself reveals a GPT model
    if (bodyModel) {
      const bodyDetection = this.detect(bodyModel, input.baseUrl);
      if (bodyDetection.isGpt) {
        this.recordAlias(input.baseUrl, rawModel, undefined, bodyDetection.normalizedModel);
        return {
          ...bodyDetection,
          rawModel,
        };
      }
    }

    return {
      isGpt: false,
      rawModel,
      normalizedModel: stripped,
      isReasoningSeries: false,
      source: 'none',
    };
  }

  recordAlias(baseUrl: string | undefined, modelAlias: string, fingerprint?: string, detectedModel?: string): void {
    const normalizedAlias = normalizeModelAlias(modelAlias);
    if (!normalizedAlias) return;
    const key = this.makeAliasKey(baseUrl, modelAlias);
    this.aliasCache.set(key, {
      baseUrl: normalizeBaseUrl(baseUrl),
      modelAlias: normalizedAlias,
      fingerprint,
      detectedModel,
      recordedAt: Date.now(),
    });
  }

  hasAlias(baseUrl: string | undefined, modelAlias: string): boolean {
    return this.aliasCache.has(this.makeAliasKey(baseUrl, modelAlias));
  }

  getAliasEntry(baseUrl: string | undefined, modelAlias: string): AliasCacheEntry | undefined {
    const entry = this.aliasCache.get(this.makeAliasKey(baseUrl, modelAlias));
    return entry ? { ...entry } : undefined;
  }

  clearAliasCache(): void {
    this.aliasCache.clear();
  }

  private makeAliasKey(baseUrl: string | undefined, modelAlias: string): string {
    return `${normalizeBaseUrl(baseUrl)}::${normalizeModelAlias(modelAlias)}`;
  }
}

export const gptDetector = new GptDetector();
