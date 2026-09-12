import { v4 as uuidv4 } from 'uuid';
import type { ProviderConfig, ProviderAdapter, SendMessageParams, ChatMessage, StreamChunk, AIModel } from '../../types';

// Known reasoning/thinking-capable model families. Provider /models endpoints
// almost never advertise a reasoning flag, so without these patterns every
// reasoning model would show up as "no reasoning". Matched against a lowercased
// model id. Anything still missed can be force-enabled with the 🧠 toggle.
const REASONING_MODEL_PATTERNS: RegExp[] = [
  // Generic markers — these substrings reliably mark a reasoning model whatever
  // the vendor (reasoner/reasoning, *-thinking).
  /reason/,
  /think/,

  // OpenAI — o-series (o1/o3/o4-mini…) and GPT-5. The boundary stops gpt-4o.
  /(?:^|[^a-z0-9])o[1-9](?:[^0-9]|$)/,
  /gpt-5/,

  // Anthropic — extended thinking (Claude 3.7 and Claude 4.x).
  /claude.*(?:3[.\-_]?7|-4|opus-4|sonnet-4|haiku-4)/,

  // Google Gemini 2.5 (thinking; explicit *-thinking ids handled above).
  /gemini.*2\.5/,

  // DeepSeek R1 and R1 distills.
  /(?:^|[^a-z0-9])r1(?:[^0-9]|$)/,

  // Alibaba Qwen.
  /qwq/,
  /qwen3/,

  // xAI Grok reasoning models.
  /grok-(?:3-mini|4)/,

  // Mistral Magistral.
  /magistral/,

  // Chinese reasoning families (boundaries chosen to avoid false positives,
  // e.g. hunyuan-t\d matches hunyuan-t1 but not hunyuan-turbo).
  /glm-z/,         // Zhipu GLM-Z1 / GLM-Zero
  /minimax-m\d/,   // MiniMax-M1
  /ernie-x\d/,     // Baidu ERNIE X1
  /hunyuan-t\d/,   // Tencent Hunyuan-T1
  /kimi.*1\.5/,    // Moonshot Kimi k1.5
  /step.*r1/,      // StepFun Step-R1
  /mimo/,          // Xiaomi MiMo
];

// Like reasoning, most /models endpoints don't advertise a per-modality flag, so
// the detectors below trust API metadata first (modalities / supported_parameters)
// and fall back to these id patterns. Matched against a lowercased model id.

// Image *input* (vision).
const VISION_MODEL_PATTERNS: RegExp[] = [
  /vision/, /multimodal/, /qwen.*vl/, /-vl(?:[^a-z]|$)/,
  /gpt-4o/, /gpt-4\.1/, /gpt-4-turbo/, /gpt-5/, /chatgpt-4o/,
  /claude-3/, /claude-(?:opus|sonnet|haiku)-4/, /claude.*(?:opus|sonnet|haiku)-4/,
  /gemini/,
  /llava/, /pixtral/, /llama.*vision/, /internvl/, /minicpm-v/,
  /glm-4v/, /glm-4\.\dv/, /step-1v/, /cogvlm/, /kimi-vl/, /grok-(?:2-vision|4)/,
];

// Image *output* (generation).
const IMAGE_GEN_MODEL_PATTERNS: RegExp[] = [
  /dall-?e/, /gpt-image/, /imagen/, /flux/, /stable-diffusion/, /\bsdxl\b/, /\bsd3\b/,
  /midjourney/, /ideogram/, /recraft/, /cogview/, /kolors/, /seedream/, /playground-v/,
  /qwen-image/, /flash-image/, /-image-preview/, /text-to-image/, /image-generation/,
];

// Audio *input* (speech recognition / audio understanding).
const AUDIO_INPUT_MODEL_PATTERNS: RegExp[] = [
  /whisper/, /transcribe/, /audio/, /realtime/, /qwen.*audio/, /voxtral/, /speech-to-text/, /\basr\b/,
];

// Audio *output* (speech synthesis).
const AUDIO_OUTPUT_MODEL_PATTERNS: RegExp[] = [
  /\btts\b/, /text-to-speech/, /audio/, /realtime/, /speech/, /cosyvoice/, /fish-speech/, /-voice/,
];

// Function / tool calling is the norm for modern chat models, so this is an
// OPT-OUT list rather than an allowlist. An allowlist of known families looked
// safer but silently downgraded every model it had never heard of — Doubao,
// Hunyuan, ERNIE, MiniMax, Yi, Step, Baichuan, and every local/custom model id —
// to the prompt protocol, which is the single biggest reason tool calling
// appeared "not implemented". Being optimistic is safe because a provider that
// really rejects `tools` is detected on the first failed turn and downgraded for
// the session (see isToolUnsupportedError in chat.store).
const NO_FUNCTION_CALLING_PATTERNS: RegExp[] = [
  // Not chat models at all.
  /embed/, /rerank/, /moderation/, /guard/,
  /whisper/, /transcrib/, /\btts\b/, /text-to-speech/, /speech-to-text/, /\basr\b/,
  /dall-?e/, /stable-diffusion/, /\bsdxl\b/, /midjourney/, /imagen/, /\bflux\b/,
  /cogview/, /kolors/, /seedream/, /text-to-image/, /image-generation/, /-image-preview/,
  // Legacy completion models that predate function calling.
  /text-davinci/, /davinci-00/, /(?:^|[^a-z])(?:curie|babbage|ada)(?:[^a-z]|$)/,
  /gpt-3\.5-turbo-instruct/, /-instruct-\d/,
  // Raw base checkpoints (not instruction-tuned).
  /-base(?:$|[^a-z])/, /\bbase-\d/,
];

export abstract class BaseAdapter implements ProviderAdapter {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract listModels(): Promise<AIModel[]>;
  abstract sendMessage(params: SendMessageParams): Promise<any>;
  abstract streamMessage(params: SendMessageParams, onChunk: (chunk: StreamChunk) => void, signal?: AbortSignal): Promise<any>;
  abstract validateApiKey(): Promise<boolean>;

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  /**
   * Fetch with a connection timeout. For streaming callers the timeout only
   * covers the wait for response HEADERS — the timer is cleared as soon as
   * fetch() resolves, so the body stream itself is bounded by the reader's idle
   * timeout (see consumeStream), not this one. Returns the raw Response.
   */
  protected async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    // Drive the fetch off our own controller so the timeout can actually abort
    // it, then forward the caller's signal (user "stop" / main-process cancel)
    // into that controller. Previously the fetch used `options.signal` directly
    // whenever a caller signal was present, which left the timeout's
    // controller.abort() wired to nothing — a hung handshake never timed out.
    // Forwarding (rather than picking one signal) keeps BOTH live: the handshake
    // timeout AND mid-stream cancellation by the caller.
    const callerSignal = options.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (e: any) {
      // Distinguish OUR handshake timeout from a caller-initiated cancel: if the
      // caller never aborted but our controller did, the timer fired. Surface it
      // as a clear timeout error instead of a raw AbortError, which upstream
      // treats as a silent user-stop and would hide the failure (spinner just
      // vanishes). A genuine caller stop still throws AbortError and stays quiet.
      if (controller.signal.aborted && !callerSignal?.aborted) {
        throw new Error(`Request timed out after ${this.config.timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Read a streaming response body, calling `onData` for each chunk. Aborts
   * if nothing arrives for `idleMs` milliseconds (resets on every chunk).
   * Returns the accumulated buffer string.
   */
  protected async consumeStream(
    response: Response,
    onData: (chunk: string) => void,
    signal?: AbortSignal,
    idleMs: number = 120_000,
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        reader.cancel().catch(() => {});
      }, idleMs);
    };

    try {
      resetIdle();
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        onData(text);
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    if (timedOut && !signal?.aborted) {
      throw new Error(`Stream idle timeout after ${idleMs}ms`);
    }
    return buffer;
  }

  /**
   * Split messages into a single combined system prompt (all system messages
   * joined together) and the remaining conversation turns. Providers like
   * Anthropic and Gemini accept only one system field, so taking just the
   * first system message would silently drop file context and tool results.
   */
  protected extractSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
    const systemParts: string[] = [];
    const rest: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const text = typeof m.content === 'string' ? m.content : '';
        if (text.trim()) systemParts.push(text);
      } else {
        rest.push(m);
      }
    }
    return { system: systemParts.join('\n\n---\n\n'), rest };
  }

  /**
   * Ensure a clean user/assistant alternation: drop a leading assistant turn,
   * and merge consecutive same-role turns. Anthropic and Gemini reject
   * sequences that don't strictly alternate.
   */
  protected normalizeAlternating(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string | import('../../types').ContentPart[] }[] {
    const out: { role: 'user' | 'assistant'; content: string | import('../../types').ContentPart[] }[] = [];
    for (const m of messages) {
      const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
      if (out.length === 0 && role === 'assistant') continue;
      const last = out[out.length - 1];
      if (last && last.role === role) {
        // Merge consecutive same-role turns; if either side has array content
        // (vision parts) keep them separate rather than corrupt the structure.
        if (typeof last.content === 'string' && typeof m.content === 'string') {
          last.content += '\n\n' + m.content;
        } else {
          // Can't merge mixed/array content cleanly — push as separate turn;
          // the API will receive them sequentially within the same role, which
          // most providers handle by taking the last one. Acceptable fallback.
          out.push({ role, content: m.content });
        }
      } else {
        out.push({ role, content: m.content });
      }
    }
    return out;
  }

  protected handleError(error: any): Error {
    if (error.name === 'AbortError') {
      return new Error('Request timed out');
    }
    if (error.status === 401) {
      return new Error('Invalid API key');
    }
    if (error.status === 429) {
      return new Error('Rate limited. Please try again later.');
    }
    if (error.status === 404) {
      return new Error('Model not found');
    }
    return error;
  }

  protected detectReasoningCapability(modelId: string, modelData?: any): boolean {
    // 1. Trust explicit API metadata when a provider actually supplies it.
    if (modelData?.reasoning === true) return true;
    if (modelData?.supports_reasoning === true) return true;
    if (modelData?.capabilities?.reasoning === true) return true;
    if (modelData?.capabilities?.thinking === true) return true;
    if (modelData?.reasoning_effort != null) return true;
    if (modelData?.thinking != null) return true;
    // OpenRouter lists tunable params; reasoning models expose these.
    const params = modelData?.supported_parameters;
    if (Array.isArray(params) && (params.includes('reasoning') || params.includes('include_reasoning'))) return true;

    // 2. Most /models endpoints return no reasoning metadata at all, so fall
    // back to matching well-known reasoning model id patterns.
    const id = (modelId || '').toLowerCase();
    return REASONING_MODEL_PATTERNS.some((re) => re.test(id));
  }

  protected mapModel(raw: any, capabilities: Partial<AIModel> = {}): AIModel {
    const modelId = raw.id || uuidv4();
    const supportsReasoning = capabilities.supportsReasoning ?? this.detectReasoningCapability(modelId, raw);
    const detectedContextWindow = this.detectContextWindow(raw);
    const detectedMaxOutput = this.detectMaxOutput(raw);

    return {
      id: modelId,
      name: raw.name || raw.id,
      providerId: this.config.id,
      supportsText: capabilities.supportsText ?? true,
      supportsVision: capabilities.supportsVision ?? this.detectVisionCapability(modelId, raw),
      supportsImageGeneration: capabilities.supportsImageGeneration ?? this.detectImageGeneration(modelId, raw),
      supportsAudioInput: capabilities.supportsAudioInput ?? this.detectAudioInput(modelId, raw),
      supportsAudioOutput: capabilities.supportsAudioOutput ?? this.detectAudioOutput(modelId, raw),
      supportsFunctionCalling: capabilities.supportsFunctionCalling ?? this.detectFunctionCalling(modelId, raw),
      supportsReasoning,
      contextWindow: capabilities.contextWindow ?? detectedContextWindow ?? 128000,
      maxOutputTokens: capabilities.maxOutputTokens ?? detectedMaxOutput ?? (supportsReasoning ? 128000 : 8192),
      enabled: true,
    };
  }

  /**
   * Read a model's context window from whatever field the provider uses. OpenAI's
   * bare /models list exposes none of these (so it falls back to the default and
   * the user can override it in the UI), but many OpenAI-compatible APIs do report
   * one of these names.
   */
  protected detectContextWindow(modelData?: any): number | undefined {
    if (!modelData) return undefined;
    return this.firstPositive([
      modelData.context_length,
      modelData.context_window,
      modelData.contextLength,
      modelData.contextWindow,
      modelData.max_context_length,
      modelData.max_context_tokens,
      modelData.maxContextLength,
      modelData.maxContextTokens,
      modelData.max_input_tokens,
      modelData.maxInputTokens,
      modelData.input_token_limit,
      modelData.inputTokenLimit,
      modelData.context_size,
      modelData.contextSize,
      modelData.top_provider?.context_length,
      modelData.top_provider?.context_window,
      modelData.top_provider?.contextWindow,
      modelData.top_provider?.max_context_tokens,
      modelData.limits?.context_length,
      modelData.limits?.context_window,
      modelData.limits?.contextWindow,
      modelData.limits?.max_context_tokens,
      modelData.limits?.maxContextTokens,
      modelData.limits?.max_input_tokens,
      modelData.limits?.maxInputTokens,
      modelData.capabilities?.context_length,
      modelData.capabilities?.context_window,
      modelData.capabilities?.contextWindow,
      modelData.capabilities?.max_context_tokens,
      modelData.architecture?.context_length,
      modelData.architecture?.context_window,
      modelData.architecture?.contextWindow,
    ]);
  }

  /** Read a model's max output/completion tokens from whatever field the provider uses. */
  protected detectMaxOutput(modelData?: any): number | undefined {
    if (!modelData) return undefined;
    return this.firstPositive([
      modelData.max_output_tokens,
      modelData.maxOutputTokens,
      modelData.max_completion_tokens,
      modelData.maxCompletionTokens,
      modelData.output_token_limit,
      modelData.outputTokenLimit,
      modelData.top_provider?.max_completion_tokens,
      modelData.top_provider?.maxCompletionTokens,
      modelData.top_provider?.max_output_tokens,
      modelData.limits?.max_completion_tokens,
      modelData.limits?.maxCompletionTokens,
      modelData.limits?.max_output_tokens,
      modelData.limits?.maxOutputTokens,
      modelData.capabilities?.max_completion_tokens,
      modelData.capabilities?.max_output_tokens,
      modelData.capabilities?.maxOutputTokens,
      modelData.max_tokens,
      modelData.maxTokens,
    ]);
  }

  private firstPositive(candidates: any[]): number | undefined {
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  /**
   * Extract declared input/output modalities from whatever shape the provider
   * uses. OpenRouter exposes `architecture.input_modalities` / `output_modalities`
   * arrays (and a combined `"text+image->text"` modality string); other APIs vary.
   * Returns lowercased sets, e.g. inputs={text,image}, outputs={text}.
   */
  protected getModalities(modelData?: any): { inputs: Set<string>; outputs: Set<string> } {
    const inputs = new Set<string>();
    const outputs = new Set<string>();
    if (!modelData) return { inputs, outputs };

    const arch = modelData.architecture || {};
    const addAll = (set: Set<string>, val: any) => {
      if (Array.isArray(val)) for (const v of val) if (typeof v === 'string') set.add(v.toLowerCase());
    };
    addAll(inputs, arch.input_modalities ?? modelData.input_modalities);
    addAll(outputs, arch.output_modalities ?? modelData.output_modalities);

    // Some APIs only give a combined "in1+in2->out1+out2" modality string.
    const modality: unknown = arch.modality ?? modelData.modality;
    if (typeof modality === 'string') {
      const lower = modality.toLowerCase();
      if (lower.includes('->')) {
        const [inPart, outPart] = lower.split('->');
        for (const m of inPart.split(/[+,/]/)) if (m.trim()) inputs.add(m.trim());
        for (const m of outPart.split(/[+,/]/)) if (m.trim()) outputs.add(m.trim());
      } else if (/image|vision|multimodal/.test(lower)) {
        inputs.add('image');
      }
    }
    return { inputs, outputs };
  }

  /** Tunable params a provider advertises for a model (OpenRouter `supported_parameters`). */
  protected getSupportedParams(modelData?: any): string[] {
    const p = modelData?.supported_parameters;
    return Array.isArray(p) ? p.map((x: any) => String(x).toLowerCase()) : [];
  }

  protected detectVisionCapability(modelId: string, modelData?: any): boolean {
    if (this.getModalities(modelData).inputs.has('image')) return true;
    if (modelData?.supports_vision === true) return true;
    if (modelData?.capabilities?.vision === true) return true;
    const id = (modelId || '').toLowerCase();
    return VISION_MODEL_PATTERNS.some((re) => re.test(id));
  }

  protected detectImageGeneration(modelId: string, modelData?: any): boolean {
    if (this.getModalities(modelData).outputs.has('image')) return true;
    if (modelData?.supports_image_generation === true) return true;
    if (modelData?.capabilities?.image_generation === true) return true;
    const id = (modelId || '').toLowerCase();
    return IMAGE_GEN_MODEL_PATTERNS.some((re) => re.test(id));
  }

  protected detectAudioInput(modelId: string, modelData?: any): boolean {
    if (this.getModalities(modelData).inputs.has('audio')) return true;
    if (modelData?.capabilities?.audio_input === true) return true;
    const id = (modelId || '').toLowerCase();
    return AUDIO_INPUT_MODEL_PATTERNS.some((re) => re.test(id));
  }

  protected detectAudioOutput(modelId: string, modelData?: any): boolean {
    if (this.getModalities(modelData).outputs.has('audio')) return true;
    if (modelData?.capabilities?.audio_output === true) return true;
    const id = (modelId || '').toLowerCase();
    return AUDIO_OUTPUT_MODEL_PATTERNS.some((re) => re.test(id));
  }

  protected detectFunctionCalling(modelId: string, modelData?: any): boolean {
    // 1. Explicit metadata wins, in both directions.
    if (modelData?.supports_function_calling === true) return true;
    if (modelData?.capabilities?.function_calling === true) return true;
    if (modelData?.capabilities?.tools === true) return true;
    if (modelData?.supports_function_calling === false) return false;
    if (modelData?.capabilities?.function_calling === false) return false;

    // 2. When a provider enumerates the parameters a model accepts (OpenRouter),
    // that list is authoritative — absence of `tools` there means no tools.
    const params = this.getSupportedParams(modelData);
    if (params.length) {
      return params.includes('tools') || params.includes('tool_choice') || params.includes('functions');
    }

    // 3. Otherwise assume yes unless the id says it can't be a tool caller.
    const id = (modelId || '').toLowerCase();
    return !NO_FUNCTION_CALLING_PATTERNS.some((re) => re.test(id));
  }
}
