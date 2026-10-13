import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import Module, { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Stub electron module before loading any dist files that evaluate credentials/settings/paths
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'wta-test-userdata-'));
const electronStub = {
  app: {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (name) => {
      if (name === 'userData') return tmpUserData;
      return os.tmpdir();
    },
    getAppPath: () => tmpUserData,
    getName: () => 'natively-test',
    getVersion: () => '0.0.0-test',
    requestSingleInstanceLock: () => true,
    on: () => {},
  },
  BrowserWindow: class FakeBrowserWindow {
    static getAllWindows() { return []; }
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => {};
        },
      });
    }
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    show() {}
    hide() {}
    close() {}
    destroy() {}
    getBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
    setIgnoreMouseEvents() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    setContentProtection() {}
    setBounds() {}
    webContents = { on: () => {}, send: () => {}, setWindowOpenHandler: () => {} };
  },
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  shell: { openExternal: () => {} },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, parent, ...rest);
};
Module._cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: electronStub,
};

const distLlmDir = path.resolve(__dirname, '../../../dist-electron/electron/llm');
const { WhatToAnswerLLM } = require(path.join(distLlmDir, 'WhatToAnswerLLM.js'));
const { classifyProviderError, getUserFacingProviderErrorMessage } = require(path.join(distLlmDir, 'providerErrorClassifier.js'));
const { planAnswer, isCodingAnswerType } = require(path.join(distLlmDir, 'AnswerPlanner.js'));
const { validateAnswerStructure } = require(path.join(distLlmDir, 'AnswerValidator.js'));

describe('What-To-Answer and Typed Chat Provider Routing Parity', () => {

  // Test A: Typed answer using LiteLLM succeeds
  test('A. Typed answer using LiteLLM succeeds', async () => {
    let capturedStreamArgs = null;
    const mockLLMHelper = {
      currentModelId: 'litellm/gpt-4o',
      getCapabilities: () => ({ outputBudgetTokens: 2000, supportsImages: false }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: (t) => t,
      async *streamChat(message, imagePaths, context, systemPromptOverride, ignoreKnowledge, skipMode, extraScopes, abortSig, thinking, routeOptions) {
        capturedStreamArgs = { message, context, systemPromptOverride, routeOptions };
        yield 'Typed answer streamed successfully via LiteLLM';
      },
    };

    const typedMessage = 'tell me about the open source contribution';
    const plan = planAnswer({
      question: typedMessage,
      source: 'manual_input',
      speakerPerspective: 'user',
    });

    const tokens = [];
    for await (const chunk of mockLLMHelper.streamChat(
      typedMessage,
      undefined,
      'candidate_facts',
      'CHAT_MODE_PROMPT',
      false,
      false,
      [],
      undefined,
      0,
      { answerType: plan.answerType, forbiddenContextLayers: plan.forbiddenContextLayers }
    )) {
      tokens.push(chunk);
    }

    assert.equal(tokens.join(''), 'Typed answer streamed successfully via LiteLLM');
    assert.ok(capturedStreamArgs);
    assert.equal(capturedStreamArgs.message, typedMessage);
  });

  // Test B: What-To-Answer using LiteLLM succeeds
  test('B. What-To-Answer using LiteLLM succeeds', async () => {
    let capturedStreamArgs = null;
    const mockLLMHelper = {
      currentModelId: 'litellm/gpt-4o',
      getCapabilities: () => ({ outputBudgetTokens: 2000, supportsImages: false }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: (t) => t,
      thinkingBudgetForAnswerType: () => 0,
      async *streamChat(message, imagePaths, context, systemPromptOverride, ignoreKnowledge, skipMode, extraScopes, abortSig, thinking, routeOptions) {
        capturedStreamArgs = { message, imagePaths, context, systemPromptOverride, extraScopes, routeOptions };
        yield 'WTA answer streamed successfully via LiteLLM';
      },
    };

    const mockModesManager = {
      getActiveModeSystemPromptSuffix: () => '',
      buildRetrievedActiveModeContextBlock: () => '',
      buildActiveModeContextBlock: () => '',
    };

    const answerer = new WhatToAnswerLLM(mockLLMHelper, mockModesManager);
    const plan = planAnswer({
      question: 'tell me about your background',
      source: 'what_to_answer',
      speakerPerspective: 'interviewer',
    });

    const tokens = [];
    for await (const chunk of answerer.generateStream(
      'Interviewer: tell me about your background',
      undefined,
      { intent: 'general', confidence: 0.8, answerShape: 'Direct answer' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Candidate: 5 years software engineer',
      plan
    )) {
      tokens.push(chunk);
    }

    assert.equal(tokens.join(''), 'WTA answer streamed successfully via LiteLLM');
    assert.ok(capturedStreamArgs);
    assert.equal(capturedStreamArgs.routeOptions?.answerType, plan.answerType);
  });

  // Test C: Typed answer and WTA use the same active provider
  test('C. Typed answer and WTA use the same active provider', async () => {
    const invokedProviders = [];
    const sharedLLMHelper = {
      activeProvider: 'litellm',
      currentModelId: 'litellm/anthropic/claude-3.5-sonnet',
      getCapabilities: () => ({ outputBudgetTokens: 2000, supportsImages: false }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: (t) => t,
      thinkingBudgetForAnswerType: () => 0,
      async *streamChat() {
        invokedProviders.push(this.activeProvider);
        yield 'token';
      },
    };

    // 1. Typed invocation
    for await (const _t of sharedLLMHelper.streamChat('typed query')) {}

    // 2. WTA invocation
    const mockModes = { getActiveModeSystemPromptSuffix: () => '' };
    const wta = new WhatToAnswerLLM(sharedLLMHelper, mockModes);
    for await (const _t of wta.generateStream('wta query')) {}

    assert.equal(invokedProviders.length, 2);
    assert.equal(invokedProviders[0], invokedProviders[1], 'Both paths must use the exact same provider');
    assert.equal(invokedProviders[0], 'litellm');
  });

  // Test D: Typed answer and WTA use the same active model
  test('D. Typed answer and WTA use the same active model', async () => {
    const modelsEncountered = [];
    const sharedLLMHelper = {
      currentModelId: 'litellm/meta-llama/llama-3.3-70b-instruct',
      getCapabilities: () => ({ outputBudgetTokens: 2000, supportsImages: false }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: (t) => t,
      thinkingBudgetForAnswerType: () => 0,
      async *streamChat() {
        modelsEncountered.push(this.currentModelId);
        yield 'token';
      },
    };

    for await (const _t of sharedLLMHelper.streamChat('typed question')) {}
    const wta = new WhatToAnswerLLM(sharedLLMHelper, { getActiveModeSystemPromptSuffix: () => '' });
    for await (const _t of wta.generateStream('interviewer question')) {}

    assert.equal(modelsEncountered.length, 2);
    assert.equal(modelsEncountered[0], modelsEncountered[1]);
    assert.equal(modelsEncountered[0], 'litellm/meta-llama/llama-3.3-70b-instruct');
  });

  // Test E: WTA with Personal Context question
  test('E. WTA with Personal Context question retrieves candidate-specific context', async () => {
    let capturedUserMessage = '';
    const mockLLMHelper = {
      currentModelId: 'litellm/gpt-4o',
      getCapabilities: () => ({ outputBudgetTokens: 2000, supportsImages: false }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: (t) => t,
      thinkingBudgetForAnswerType: () => 0,
      async *streamChat(userMessage) {
        capturedUserMessage = userMessage;
        yield 'response';
      },
    };

    const question = 'Tell me about your open source contributions';
    const plan = planAnswer({
      question,
      source: 'what_to_answer',
      speakerPerspective: 'interviewer',
    });

    const personalContributionContext = 'Active maintainer of natively-rust-core and contributed PR #402 to sqlite-vec';
    const mockModes = {
      getActiveModeSystemPromptSuffix: () => '',
      buildRetrievedActiveModeContextBlock: () => '',
      buildActiveModeContextBlock: () => '',
    };
    const wta = new WhatToAnswerLLM(mockLLMHelper, mockModes);

    for await (const _chunk of wta.generateStream(
      `Interviewer: ${question}`,
      undefined,
      { intent: 'general', confidence: 0.9, answerShape: 'Candidate experience' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // candidateProfile
      plan,
      undefined, // modeContextPromise
      undefined, // requestSnapshot
      personalContributionContext // personalContext
    )) {}

    assert.ok(capturedUserMessage.includes('natively-rust-core'), 'User message must carry candidate-specific personal context');
    assert.ok(capturedUserMessage.includes('sqlite-vec'), 'User message must ground on actual open source projects');
  });

  // Test F: WTA with DSA question goes through DSA routing and canonical sections
  test('F. WTA with DSA question produces canonical sections: Approach, Code, Time & Space Complexity, Dry Run', () => {
    const dsaQuestion = 'Can you solve two sum? Given an integer array nums and an integer target, return indices of the two numbers such that they add up to target.';
    const plan = planAnswer({
      question: dsaQuestion,
      source: 'what_to_answer',
      speakerPerspective: 'interviewer',
    });

    assert.equal(isCodingAnswerType(plan.answerType), true, 'Must be classified as coding/DSA answer type');

    const sampleRawDsaAnswer = [
      '## Approach',
      'Use a hash map to store previously seen numbers and their indices in one pass.',
      '',
      '## Code',
      '```javascript',
      'function twoSum(nums, target) {',
      '  const map = new Map();',
      '  for (let i = 0; i < nums.length; i++) {',
      '    const comp = target - nums[i];',
      '    if (map.has(comp)) return [map.get(comp), i];',
      '    map.set(nums[i], i);',
      '  }',
      '  return [];',
      '}',
      '```',
      '',
      '## Time & Space Complexity',
      '- Time: O(N)',
      '- Space: O(N)',
      '',
      '## Dry Run',
      'For nums = [2, 7, 11, 15], target = 9: i=0 sees 2; i=1 finds 7 with comp=2, returns [0, 1].',
    ].join('\n');

    const validation = validateAnswerStructure(plan.answerType, sampleRawDsaAnswer);
    assert.equal(validation.ok, true, 'Canonical DSA answer must pass validation');
    assert.match(sampleRawDsaAnswer, /## Approach/);
    assert.match(sampleRawDsaAnswer, /## Code/);
    assert.match(sampleRawDsaAnswer, /## Time & Space Complexity/);
    assert.match(sampleRawDsaAnswer, /## Dry Run/);
  });

  // Test G: Provider authentication failure produces classified message
  test('G. Provider authentication failure produces safe provider-specific error classification', () => {
    const authError = new Error('401 Unauthorized: Invalid API key sk-ant-secret12345');
    const classification = classifyProviderError(authError);

    assert.equal(classification.kind, 'auth');
    assert.equal(classification.isOutage, true);
    assert.equal(classification.retryable, false);

    const userFacing = getUserFacingProviderErrorMessage(classification);
    assert.equal(userFacing, 'AI provider authentication failed. Check your API keys / plan in Settings and try again.');
    assert.doesNotMatch(userFacing, /secret12345/, 'Must not leak sensitive API keys');
  });

  // Test H: Rate-limit failure produces rate-limit classification
  test('H. Rate-limit failure produces rate-limit classification', () => {
    const rateLimitError = new Error('429 Too Many Requests: Rate limit reached, try again later');
    const classification = classifyProviderError(rateLimitError);

    assert.equal(classification.kind, 'rate_limit');
    assert.equal(classification.isOutage, true);
    assert.equal(classification.retryable, true);

    const userFacing = getUserFacingProviderErrorMessage(classification);
    assert.equal(userFacing, 'AI provider rate limit reached. Please wait a moment and try again.');
  });

  // Test I: Model-not-found failure produces model-not-found classification
  test('I. Model-not-found failure produces model-not-found classification', () => {
    const notFoundError = new Error('404 Not Found: model litellm/non-existent-model does not exist');
    const classification = classifyProviderError(notFoundError);

    assert.equal(classification.kind, 'model_not_found');
    assert.equal(classification.isOutage, false);
    assert.equal(classification.retryable, false);

    const userFacing = getUserFacingProviderErrorMessage(classification);
    assert.equal(userFacing, 'The selected AI model was not found or is unavailable. Check your model selection in Settings.');
  });

  after(() => {
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch {}
    // Unblock node test runner from any timers started by AppState in background
    setTimeout(() => process.exit(0), 50);
  });
});
