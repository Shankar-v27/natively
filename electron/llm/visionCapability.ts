// electron/llm/visionCapability.ts
//
// Pure, dependency-free helpers for deciding whether a LOCAL provider (Ollama
// model, custom cURL endpoint) can actually accept an image. Kept free of fetch
// / fs / Electron so the decision logic is unit-testable; the I/O (Ollama
// /api/show probe, reading the model list) stays in LLMHelper and feeds these.
//
// Why this exists: cloud providers (OpenAI/Claude/Gemini/Groq) have known,
// fixed vision support. Local providers don't — an Ollama install can hold any
// mix of text-only and vision models, and a custom cURL endpoint can be any
// shape. Guessing wrong means either (a) skipping a capable provider, or worse
// (b) "committing" to a provider that silently drops the image and answers
// text-only. These helpers make the decision authoritative where possible and
// conservative otherwise.

// ── Ollama ──────────────────────────────────────────────────────────────────

// Name heuristic (fallback only). Ollama's /api/show `capabilities` array is the
// authoritative source; this regex is used when capabilities are absent (older
// Ollama servers) or the probe failed.
const OLLAMA_VISION_NAME_RE =
  /(llava|bakllava|moondream|llama-?3\.2-vision|llama3\.2-vision|gemma3|minicpm-v|qwen2\.5-vl|qwen2-vl|pixtral|llama-?4|granite3\.2-vision|mistral-small3\.1|llama-?guard3-vision)/i;

export function isOllamaVisionModelByName(modelId: string): boolean {
  return !!modelId && OLLAMA_VISION_NAME_RE.test(modelId.toLowerCase());
}

/**
 * Decide vision support from an Ollama /api/show response.
 *   - returns true/false when the response carries a `capabilities` array
 *     (authoritative — Ollama lists "vision" for multimodal models)
 *   - returns null when capabilities are absent, so the caller falls back to
 *     the name heuristic.
 */
export function ollamaVisionFromShow(showJson: any): boolean | null {
  const caps = showJson?.capabilities;
  if (Array.isArray(caps)) {
    return caps.some((c: any) => typeof c === 'string' && c.toLowerCase() === 'vision');
  }
  return null;
}

/**
 * Combine the authoritative probe result with the name heuristic.
 * `probed` is the value from ollamaVisionFromShow (true/false/null).
 */
export function resolveOllamaVision(modelId: string, probed: boolean | null): boolean {
  if (probed !== null) return probed;
  return isOllamaVisionModelByName(modelId);
}

// ── Custom cURL provider ──────────────────────────────────────────────────────

/**
 * Decide whether a custom cURL provider can carry an image.
 *
 * A custom provider supports vision when EITHER:
 *   1. The user explicitly wired the image into the template via the
 *      `{{IMAGE_BASE64}}` placeholder (they know their endpoint's image field), OR
 *   2. The request body is OpenAI-chat-compatible (`messages` array), in which
 *      case `injectImageIntoMessages` auto-upgrades the last user message to a
 *      multimodal `image_url` content array.
 *
 * An explicit `multimodal` flag, when present, overrides the auto-detection
 * (true forces on, false forces off) so users can correct a wrong guess.
 *
 * Conservative by design: a non-OpenAI body with no `{{IMAGE_BASE64}}` returns
 * false, so the chain SKIPS the provider for vision instead of committing to it
 * and silently dropping the screenshot.
 */
export function customProviderSupportsVision(
  provider: { curlCommand?: string; multimodal?: boolean } | null | undefined,
): boolean {
  if (!provider) return false;
  if (typeof provider.multimodal === 'boolean') return provider.multimodal;

  const curl = provider.curlCommand || '';
  if (!curl) return false;

  // (1) Explicit image placeholder anywhere in the template.
  if (/\{\{\s*IMAGE_BASE64\s*\}\}/i.test(curl)) return true;

  // (2) OpenAI-compatible body: look for a JSON `"messages"` array in the
  //     payload. We avoid a full JSON parse (the body contains {{TEXT}}-style
  //     placeholders that aren't valid JSON) and instead detect the canonical
  //     OpenAI shape: a `"messages"` array containing a `"role":"user"` message.
  //     We require the USER role specifically because injectImageIntoMessages
  //     only upgrades a user message — a system-only `messages` body would pass
  //     a looser check but then silently drop the image. Aligning detection
  //     with the injector's precondition prevents committing to a provider that
  //     can't actually carry the screenshot.
  const hasMessagesArray = /"messages"\s*:\s*\[/.test(curl);
  const hasUserRole = /"role"\s*:\s*"user"/.test(curl);
  return hasMessagesArray && hasUserRole;
}

/**
 * Heuristically decide whether a custom provider's endpoint is loopback/local,
 * so local-only mode keeps using it and the chain doesn't treat it as a cloud
 * provider. Inspects the first http(s) URL in the cURL template for a
 * loopback / link-local / RFC-1918 private host.
 *
 * An explicit `localOnly` flag, when present, wins over URL detection.
 */
export function customProviderIsLocal(
  provider: { curlCommand?: string; localOnly?: boolean } | null | undefined,
): boolean {
  if (!provider) return false;
  if (typeof provider.localOnly === 'boolean') return provider.localOnly;

  const curl = provider.curlCommand || '';
  const m = curl.match(/https?:\/\/[^\s'"`]+/i);
  if (!m) return false;
  let host: string;
  try {
    host = new URL(m[0]).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (host.startsWith('169.254.')) return true;      // link-local
  if (host.startsWith('10.')) return true;            // RFC-1918
  if (host.startsWith('192.168.')) return true;       // RFC-1918
  if (host.startsWith('172.')) {                      // RFC-1918 172.16.0.0–172.31.255.255
    const second = parseInt(host.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// ── LiteLLM / OpenRouter Model Vision Capability ──────────────────────────────

export type LiteLLMVisionStatus = 'supported' | 'unsupported' | 'unknown';

/**
 * Determine whether a LiteLLM / OpenRouter model is known to support image / multimodal input.
 *
 * Requirements:
 * - 'supported': Known multimodal models (e.g. gpt-4o, gpt-4.1, gpt-5, claude-3, claude-3.5,
 *                claude-3.7, claude-4, gemini-*, qwen2.5-vl, pixtral, etc.)
 * - 'unsupported': Known text-only models (e.g. gpt-3.5, o1-mini, deepseek-chat, deepseek-coder,
 *                  deepseek-reasoner, llama-3.3-70b-versatile, llama-3.1-8b, mixtral-*, gpt-oss-*)
 * - 'unknown': Metadata is unavailable or model is novel / custom / fine-tune.
 *              The caller may safely attempt the request and handle errors cleanly.
 */
export function getLiteLLMVisionStatus(modelId: string): LiteLLMVisionStatus {
  if (!modelId) return 'unknown';

  let raw = modelId.trim();
  if (raw.toLowerCase().startsWith('litellm/')) {
    raw = raw.slice('litellm/'.length).trim();
  }

  const lower = raw.toLowerCase();
  // Strip provider org prefix if present (e.g. "anthropic/claude-3-5-sonnet" -> "claude-3-5-sonnet")
  const parts = lower.split('/');
  const name = parts[parts.length - 1];

  // 1. Explicit vision identifiers in model name
  if (
    name.includes('vision') ||
    name.includes('-vl') ||
    name.includes('/vl') ||
    name.includes('multimodal') ||
    name.startsWith('qwen2.5-vl') ||
    name.startsWith('qwen2-vl') ||
    name.startsWith('pixtral') ||
    name.startsWith('minicpm-v') ||
    name.startsWith('llava') ||
    name.startsWith('bakllava') ||
    name.startsWith('moondream') ||
    name.startsWith('gemini-') ||
    lower.startsWith('models/gemini') ||
    name.startsWith('gpt-4o') ||
    name.startsWith('gpt-4.1') ||
    name.startsWith('gpt-5') ||
    name.startsWith('gpt-4-turbo') ||
    name.startsWith('gpt-4-vision') ||
    name.startsWith('claude-3') ||
    name.startsWith('claude-4') ||
    name.startsWith('claude-sonnet') ||
    name.startsWith('claude-opus') ||
    name === 'natively' ||
    name.startsWith('natively-') ||
    // o1/o3/o4 full models (not mini/preview)
    ((name.startsWith('o1') || name.startsWith('o3') || name.startsWith('o4')) &&
      !name.includes('mini') &&
      !name.includes('preview'))
  ) {
    return 'supported';
  }

  // 2. Explicit known text-only models
  if (
    name.includes('embed') ||
    name.includes('embedding') ||
    name.includes('whisper') ||
    name.includes('tts') ||
    name.includes('rerank') ||
    name.startsWith('o1-mini') ||
    name.startsWith('o1-preview') ||
    name.startsWith('gpt-3.5') ||
    name.startsWith('gpt-35') ||
    name.startsWith('text-davinci') ||
    name.startsWith('gpt-4-0314') ||
    name.startsWith('gpt-4-0613') ||
    name.startsWith('claude-1') ||
    name.startsWith('claude-2') ||
    name.startsWith('claude-instant') ||
    name.startsWith('deepseek-chat') ||
    name.startsWith('deepseek-coder') ||
    name.startsWith('deepseek-reasoner') ||
    name.startsWith('deepseek-v3') ||
    name.startsWith('deepseek-r1') ||
    name.startsWith('llama-3.3') ||
    name.startsWith('llama-3.1') ||
    name.startsWith('llama-3-') ||
    name.startsWith('llama-2-') ||
    name.startsWith('mixtral-') ||
    name.startsWith('mistral-7b') ||
    name.startsWith('mistral-small') ||
    name.startsWith('qwen2.5-coder') ||
    name.startsWith('qwen2.5-7b') ||
    name.startsWith('qwen2-7b') ||
    name.startsWith('gpt-oss-') ||
    name.includes('gpt-oss')
  ) {
    return 'unsupported';
  }

  return 'unknown';
}

// ── Groq Model Identification ─────────────────────────────────────────────────

/**
 * Determine whether a model ID is routed to Groq.
 *
 * Requirements:
 * - Recognizes standard Groq models: llama-*, meta-llama/*, mixtral-*, gemma-*, qwen/*, deepseek-r1-distill-*
 * - Recognizes specific Groq-hosted open-weights models like openai/gpt-oss-120b
 * - Does NOT treat arbitrary "openai/..." models (like OpenRouter or OpenAI models) as Groq
 * - Does NOT treat "litellm/..." models as direct Groq
 * - Honors stored groqPreferredModel when configured
 */
export function isGroqModelIdentifier(modelId: string, groqPreferredModel?: string): boolean {
  if (!modelId) return false;
  // If the model belongs to LiteLLM proxy, it is NOT direct Groq
  if (modelId.startsWith('litellm/')) return false;

  const id = modelId.trim();
  const lower = id.toLowerCase();

  // If user explicitly configured this exact model as their Groq preferred model:
  if (groqPreferredModel && id === groqPreferredModel.trim()) {
    return true;
  }

  // Classic Groq model naming patterns:
  if (
    lower.startsWith('llama-') ||
    lower.startsWith('meta-llama/') ||
    lower.startsWith('mixtral-') ||
    lower.startsWith('gemma-') ||
    lower.startsWith('gemma2-') ||
    lower.startsWith('qwen/') ||
    lower.startsWith('qwen-') ||
    lower.startsWith('deepseek-r1-distill-')
  ) {
    return true;
  }

  // Specific Groq-hosted open-weights models (e.g. openai/gpt-oss-120b, openai/gpt-oss-20b)
  // CRITICAL: Do NOT match all "openai/" — only the specific Groq-hosted gpt-oss family!
  if (/^openai\/gpt-oss(-|\b)/i.test(lower)) {
    return true;
  }

  return false;
}

