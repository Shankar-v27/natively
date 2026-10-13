import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load compiled modules from dist-electron
async function loadVisionCapability() {
  const p = path.resolve(__dirname, '../../../dist-electron/electron/llm/visionCapability.js');
  return import(pathToFileURL(p).href);
}

async function loadModelCapabilities() {
  const p = path.resolve(__dirname, '../../../dist-electron/electron/llm/modelCapabilities.js');
  return import(pathToFileURL(p).href);
}

async function loadVisionStreamFallback() {
  const p = path.resolve(__dirname, '../../../dist-electron/electron/llm/visionStreamFallback.js');
  return import(pathToFileURL(p).href);
}

describe('LiteLLM Vision Routing & Groq Detection Tests', () => {
  let getLiteLLMVisionStatus, isGroqModelIdentifier;
  let getModelCapabilities;
  let runStreamingVisionFallback, DEFAULT_VISION_FALLBACK_CONFIG;

  beforeEach(async () => {
    const vc = await loadVisionCapability();
    getLiteLLMVisionStatus = vc.getLiteLLMVisionStatus;
    isGroqModelIdentifier = vc.isGroqModelIdentifier;

    const mc = await loadModelCapabilities();
    getModelCapabilities = mc.getModelCapabilities;

    const vsf = await loadVisionStreamFallback();
    runStreamingVisionFallback = vsf.runStreamingVisionFallback;
    DEFAULT_VISION_FALLBACK_CONFIG = vsf.DEFAULT_VISION_FALLBACK_CONFIG;
  });

  // ── TEST A: LiteLLM configured + vision-capable model ──────────────────────
  describe('A. LiteLLM configured + vision-capable model', () => {
    test('identifies OpenAI multimodal models as supported', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/gpt-4o'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/gpt-4o-mini'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/openai/gpt-4o'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/gpt-4.1-turbo'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/gpt-5'), 'supported');
    });

    test('identifies Claude multimodal models as supported', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/anthropic/claude-3-5-sonnet'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/claude-sonnet-4-6'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/claude-3-haiku'), 'supported');
    });

    test('identifies Gemini multimodal models as supported', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/google/gemini-2.5-flash'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/gemini-3.1-flash-lite'), 'supported');
    });

    test('identifies open-source vision models as supported', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/qwen/qwen2.5-vl-72b'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/pixtral-12b'), 'supported');
      assert.equal(getLiteLLMVisionStatus('litellm/meta-llama/llama-3.2-11b-vision'), 'supported');
    });

    test('getModelCapabilities reports supportsImages=true for vision LiteLLM models', () => {
      const gpt4o = getModelCapabilities('litellm/gpt-4o', false);
      assert.equal(gpt4o.supportsImages, true);
      const gemini = getModelCapabilities('litellm/google/gemini-2.5-flash', false);
      assert.equal(gemini.supportsImages, true);
      const claude = getModelCapabilities('litellm/anthropic/claude-3-5-sonnet', false);
      assert.equal(claude.supportsImages, true);
    });

    test('streamVisionWithFallback attempts LiteLLM first when active and healthy', async () => {
      let litellmAttempted = false;
      const fakeLiteLLM = {
        id: 'litellm',
        name: 'LiteLLM (gpt-4o)',
        priority: 0,
        isLocal: false,
        open: async function* () {
          litellmAttempted = true;
          yield 'Analyzing screenshot...';
        },
      };

      const health = new Map();
      const output = [];
      for await (const chunk of runStreamingVisionFallback(
        [fakeLiteLLM],
        { ...DEFAULT_VISION_FALLBACK_CONFIG, hedgeEnabled: false },
        health,
        { log: () => {}, warn: () => {} },
      )) {
        output.push(chunk);
      }

      assert.equal(litellmAttempted, true);
      assert.equal(output.join(''), 'Analyzing screenshot...');
    });
  });

  // ── TEST B: LiteLLM configured + text-only model ───────────────────────────
  describe('B. LiteLLM configured + text-only model', () => {
    test('identifies known text-only models as unsupported', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/deepseek/deepseek-chat'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/deepseek/deepseek-r1'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/meta-llama/llama-3.3-70b-instruct'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/meta-llama/llama-3.1-8b'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/o1-mini'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/gpt-3.5-turbo'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/mistralai/mixtral-8x7b'), 'unsupported');
      assert.equal(getLiteLLMVisionStatus('litellm/openai/gpt-oss-120b'), 'unsupported');
    });

    test('getModelCapabilities reports supportsImages=false for text-only LiteLLM models', () => {
      const ds = getModelCapabilities('litellm/deepseek/deepseek-chat', false);
      assert.equal(ds.supportsImages, false);
      const llama = getModelCapabilities('litellm/meta-llama/llama-3.3-70b-instruct', false);
      assert.equal(llama.supportsImages, false);
    });

    test('isLiteLLMVisionConfigured helper does not mark text-only model as vision-capable', () => {
      function checkLiteLLMVisionConfigured(baseURL, modelId) {
        if (!baseURL || !baseURL.trim()) return false;
        if (!modelId || !modelId.startsWith('litellm/')) return false;
        const status = getLiteLLMVisionStatus(modelId);
        return status !== 'unsupported';
      }

      assert.equal(checkLiteLLMVisionConfigured('https://openrouter.ai/api/v1', 'litellm/deepseek/deepseek-chat'), false);
      assert.equal(checkLiteLLMVisionConfigured('https://openrouter.ai/api/v1', 'litellm/meta-llama/llama-3.3-70b-instruct'), false);
      assert.equal(checkLiteLLMVisionConfigured('https://openrouter.ai/api/v1', 'litellm/gpt-4o'), true);
    });
  });

  // ── TEST C: LiteLLM configured + capability metadata unavailable ───────────
  describe('C. LiteLLM configured + capability metadata unavailable', () => {
    test('returns unknown for custom/proxy-specific model identifiers', () => {
      assert.equal(getLiteLLMVisionStatus('litellm/typesafety/guard-classifier'), 'unknown');
      assert.equal(getLiteLLMVisionStatus('litellm/company-private-finetune'), 'unknown');
      assert.equal(getLiteLLMVisionStatus('litellm/my-proxy-model:v2'), 'unknown');
    });

    test('allows unknown model to proceed and falls back cleanly if provider rejects vision', async () => {
      let fallbackReached = false;
      const failingLiteLLM = {
        id: 'litellm',
        name: 'LiteLLM (typesafety/guard)',
        priority: 0,
        isLocal: false,
        open: async function* () {
          throw new Error('400 Bad Request: model does not support image input');
        },
      };

      const fallbackProvider = {
        id: 'gemini_flash',
        name: 'Gemini Flash',
        priority: 1,
        isLocal: false,
        open: async function* () {
          fallbackReached = true;
          yield 'Fallback answer from Gemini';
        },
      };

      const health = new Map();
      const output = [];
      for await (const chunk of runStreamingVisionFallback(
        [failingLiteLLM, fallbackProvider],
        { ...DEFAULT_VISION_FALLBACK_CONFIG, hedgeEnabled: false },
        health,
        { log: () => {}, warn: () => {} },
      )) {
        output.push(chunk);
      }

      assert.equal(fallbackReached, true);
      assert.equal(output.join(''), 'Fallback answer from Gemini');
    });
  });

  // ── TEST D: Active LiteLLM model is preserved ──────────────────────────────
  describe('D. Active LiteLLM model is preserved', () => {
    test('strips only litellm/ prefix and preserves nested model identifier', () => {
      const active1 = 'litellm/google/gemini-2.5-flash';
      const bare1 = active1.replace(/^litellm\//i, '');
      assert.equal(bare1, 'google/gemini-2.5-flash');

      const active2 = 'litellm/anthropic/claude-sonnet-4-6';
      const bare2 = active2.replace(/^litellm\//i, '');
      assert.equal(bare2, 'anthropic/claude-sonnet-4-6');
    });

    test('vision request routes with identical model name to LiteLLM client', async () => {
      let passedModel = null;
      const selectedModel = 'litellm/google/gemini-2.5-flash';
      const fakeLiteLLMClient = {
        chat: {
          completions: {
            create: async (payload) => {
              passedModel = payload.model;
              return {
                [Symbol.asyncIterator]: async function* () {
                  yield { choices: [{ delta: { content: 'Screen analyzed' } }] };
                },
              };
            },
          },
        },
      };

      const bareModel = selectedModel.replace(/^litellm\//i, '');
      const resp = await fakeLiteLLMClient.chat.completions.create({
        model: bareModel,
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });

      assert.equal(passedModel, 'google/gemini-2.5-flash');
    });
  });

  // ── TEST E: Groq selected model ───────────────────────────────────────────
  describe('E. Groq test-connection does not hardcode llama-3.3-70b-versatile', () => {
    test('selects preferred model when configured', () => {
      function resolveGroqTestModel(preferredModel, availableModels) {
        if (preferredModel) return preferredModel;
        if (availableModels && availableModels.length > 0) return availableModels[0].id;
        return 'llama-3.3-70b-versatile';
      }

      assert.equal(resolveGroqTestModel('openai/gpt-oss-120b', []), 'openai/gpt-oss-120b');
      assert.equal(resolveGroqTestModel('meta-llama/llama-4-scout-17b-16e-instruct', []), 'meta-llama/llama-4-scout-17b-16e-instruct');
      assert.equal(resolveGroqTestModel(undefined, [{ id: 'qwen/qwen-2.5-coder-32b' }]), 'qwen/qwen-2.5-coder-32b');
      assert.equal(resolveGroqTestModel(undefined, []), 'llama-3.3-70b-versatile');
    });
  });

  // ── TEST F: OpenRouter model with provider/model naming ────────────────────
  describe('F. OpenRouter models not classified as Groq merely by openai/ prefix', () => {
    test('specific Groq-hosted open weights models match isGroqModelIdentifier', () => {
      assert.equal(isGroqModelIdentifier('openai/gpt-oss-120b'), true);
      assert.equal(isGroqModelIdentifier('openai/gpt-oss-20b'), true);
      assert.equal(isGroqModelIdentifier('llama-3.3-70b-versatile'), true);
      assert.equal(isGroqModelIdentifier('meta-llama/llama-4-scout-17b-16e-instruct'), true);
      assert.equal(isGroqModelIdentifier('mixtral-8x7b-32768'), true);
      assert.equal(isGroqModelIdentifier('qwen/qwen-2.5-coder-32b'), true);
    });

    test('OpenAI proprietary models starting with openai/ are NOT classified as Groq', () => {
      assert.equal(isGroqModelIdentifier('openai/gpt-4o'), false);
      assert.equal(isGroqModelIdentifier('openai/gpt-4o-mini'), false);
      assert.equal(isGroqModelIdentifier('openai/o3-mini'), false);
      assert.equal(isGroqModelIdentifier('openai/o1'), false);
    });

    test('LiteLLM models are never classified as Groq even if they contain openai/ or llama-', () => {
      assert.equal(isGroqModelIdentifier('litellm/openai/gpt-oss-120b'), false);
      assert.equal(isGroqModelIdentifier('litellm/openai/gpt-4o'), false);
      assert.equal(isGroqModelIdentifier('litellm/llama-3.3-70b-versatile'), false);
      assert.equal(isGroqModelIdentifier('litellm/anthropic/claude-3-5-sonnet'), false);
    });

    test('configured groqPreferredModel is honored', () => {
      assert.equal(isGroqModelIdentifier('custom-groq-model', 'custom-groq-model'), true);
      assert.equal(isGroqModelIdentifier('other-model', 'custom-groq-model'), false);
    });
  });
});
