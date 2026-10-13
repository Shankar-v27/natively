// electron/llm/__tests__/PersonalFactGrounding.test.mjs
//
// Regression test suite for Personal Context Grounding Policy (Tests A through H).
// Ensures candidate-specific claims (projects, stacks, APIs, speech/voice providers,
// technical decisions, metrics) are strictly grounded in uploaded Personal Context.
//
// Run: npm run build:electron && node --test electron/llm/__tests__/PersonalFactGrounding.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const groundingModPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/personalFactGrounding.js');
const validatorModPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/profileEvidenceValidator.js');
const wtaModPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/WhatToAnswerLLM.js');

const {
  isGeneralTechnicalQuestion,
  extractQueriedTechnologies,
  isEntityDocumentedAsImplemented,
  analyzeEvidenceGrounding,
  detectUnsupportedImplementationClaims,
  qualifyUnsupportedImplementationClaims,
  buildPersonalContextPromptBlock,
  logPersonalFactGroundingObservability,
} = await import(pathToFileURL(groundingModPath).href);

const { validateProfileEvidence } = await import(pathToFileURL(validatorModPath).href);
const { WhatToAnswerLLM } = await import(pathToFileURL(wtaModPath).href);

// Common plan helper
const makePlan = (over = {}) => ({
  answerType: 'project_answer',
  outputPerspective: 'first_person_candidate',
  voicePerspective: 'first_person_candidate',
  profileContextPolicy: 'required',
  forbiddenContextLayers: [],
  ...over,
});

describe('Personal Fact Grounding - Core Regression Suite (Tests A through H)', () => {

  // Test A — Unsupported voice provider
  // Context: Hiremind AI uses documented recruitment automation components. No voice-generation provider is documented.
  // Question: "What did you use for the AI interviewer's voice?"
  // Expected: The response does not claim that ElevenLabs, OpenAI, Whisper, Azure, or any other provider was implemented.
  describe('Test A — Unsupported voice provider', () => {
    const HIREMIND_DOCS_NO_VOICE = `<personal_context>
[Project: Hiremind AI]
Recruitment automation platform designed for technical screening.
Architecture: FastAPI backend, PostgreSQL database, React frontend.
Features: Automated candidate screening, resume parsing, question scheduling.
</personal_context>`;

    test('Stage 4 analysis identifies missing voice provider and prohibits inventing ElevenLabs/Whisper', () => {
      const q = "What did you use for the AI interviewer's voice?";
      const analysis = analyzeEvidenceGrounding({
        question: q,
        evidence: HIREMIND_DOCS_NO_VOICE,
        answerType: 'project_answer',
      });

      assert.equal(analysis.isPersonalImplementationAsk, true);
      assert.equal(analysis.missingAspect, 'voice_generation_provider');
      assert.ok(
        analysis.groundingDirectives.some(d => d.includes('MISSING VOICE PROVIDER') && d.includes('Do NOT invent ElevenLabs')),
        'Directives must instruct model not to guess ElevenLabs or Whisper'
      );
    });

    test('Validator flags an answer that invents ElevenLabs or Whisper as unsupported_implementation', () => {
      const inventedAnswer = "For Hiremind AI, I used ElevenLabs for the AI interviewer's voice and OpenAI Whisper for speech recognition.";
      const res = validateProfileEvidence({
        answer: inventedAnswer,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_NO_VOICE,
        question: "What did you use for the AI interviewer's voice?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, false);
      assert.ok(res.errorCodes.includes('unsupported_implementation'));
      assert.ok(
        res.violations.some(v => v.detail.toLowerCase().includes('elevenlabs') || v.detail.toLowerCase().includes('whisper')),
        'Must flag ElevenLabs or Whisper as unsupported'
      );
    });

    test('Deterministic qualification rewrites unsupported voice provider to honest acknowledgement', () => {
      const inventedAnswer = "In Hiremind AI, I used ElevenLabs for the voice generation.";
      const detection = detectUnsupportedImplementationClaims(inventedAnswer, HIREMIND_DOCS_NO_VOICE);
      assert.ok(detection.unsupportedClaims.includes('elevenlabs'));

      const qualified = qualifyUnsupportedImplementationClaims(inventedAnswer, detection.unsupportedClaims, {
        question: "What did you use for the AI interviewer's voice?",
      });

      assert.ok(!qualified.toLowerCase().includes('elevenlabs'), 'Qualified text must not claim ElevenLabs');
      assert.match(qualified, /don't have the exact voice-generation provider documented/i);
    });
  });

  // Test B — Explicitly documented provider
  // Context: The project documentation explicitly states that Provider X was implemented for text-to-speech.
  // Expected: The answer may identify Provider X as the implemented provider.
  describe('Test B — Explicitly documented provider', () => {
    const HIREMIND_DOCS_WITH_PROVIDER_X = `<personal_context>
[Project: Hiremind AI]
Recruitment automation platform designed for technical screening.
Architecture: FastAPI backend, PostgreSQL database, React frontend.
Voice Pipeline: Implemented ProviderX text-to-speech API for the AI interviewer's voice synthesis.
</personal_context>`;

    test('isEntityDocumentedAsImplemented recognizes ProviderX as an implemented tool', () => {
      const status = isEntityDocumentedAsImplemented('ProviderX', HIREMIND_DOCS_WITH_PROVIDER_X);
      assert.equal(status.documented, true);
      assert.equal(status.isFutureOrComparisonOnly, false);
    });

    test('An answer identifying documented ProviderX passes validation with ok: true', () => {
      const answer = "For Hiremind AI, I used ProviderX for the text-to-speech synthesis in the AI interviewer voice.";
      const res = validateProfileEvidence({
        answer,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_WITH_PROVIDER_X,
        question: "What did you use for the AI interviewer's voice?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, true, `Expected ok: true but got violations: ${JSON.stringify(res.violations)}`);
      assert.equal(res.errorCodes.includes('unsupported_implementation'), false);
    });
  });

  // Test C — Related technology is not implementation evidence
  // Context: The documentation mentions Whisper in a comparison or future-work section, not in the implementation.
  // Expected: The answer does not claim Whisper was used.
  describe('Test C — Related technology is not implementation evidence', () => {
    const HIREMIND_DOCS_WHISPER_COMPARISON = `<personal_context>
[Project: Hiremind AI]
Automated recruitment screening platform.
Implementation: Web Speech API for candidate transcription.
Comparison & Future Work:
- The documentation mentions Whisper in a comparison or future-work section, not in the implementation.
- Evaluated OpenAI Whisper against Deepgram for future latency benchmarks.
</personal_context>`;

    test('isEntityDocumentedAsImplemented marks Whisper as future/comparison only', () => {
      const status = isEntityDocumentedAsImplemented('Whisper', HIREMIND_DOCS_WHISPER_COMPARISON);
      assert.equal(status.documented, true);
      assert.equal(status.isFutureOrComparisonOnly, true, 'Whisper must be marked as comparison/future only');
    });

    test('Claiming Whisper as implemented is flagged as unsupported_implementation', () => {
      const answer = "In Hiremind AI, I used Whisper for speech-to-text transcription.";
      const res = validateProfileEvidence({
        answer,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_WHISPER_COMPARISON,
        question: "How did you implement transcription in Hiremind?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, false);
      assert.ok(res.errorCodes.includes('unsupported_implementation'));
      assert.ok(
        res.violations.some(v => v.detail.toLowerCase().includes('whisper')),
        'Must flag Whisper because it is only documented in comparison/future work'
      );
    });
  });

  // Test D — Partial evidence
  // Context: The project documentation confirms a backend and a voice-generation feature but does not identify the underlying provider.
  // Expected: The answer describes the documented architecture and acknowledges the missing provider.
  describe('Test D — Partial evidence', () => {
    const HIREMIND_DOCS_PARTIAL = `<personal_context>
[Project: Hiremind AI]
Automated interview system featuring an AI interviewer with real-time speech generation.
Backend: FastAPI service managing candidate evaluation and question streaming.
Database: PostgreSQL for session transcripts and candidate scores.
Note: Voice playback is streamed via WebSockets to the React frontend.
</personal_context>`;

    test('Answer describing documented architecture while acknowledging unrecorded provider passes', () => {
      const honestAnswer = "In Hiremind AI, the AI interviewer uses real-time speech generation streamed via WebSockets from a FastAPI backend and PostgreSQL. I don't have the exact voice-generation provider documented in my project context, so I don't want to guess, but the pipeline streams audio chunks directly to the React frontend.";

      const res = validateProfileEvidence({
        answer: honestAnswer,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_PARTIAL,
        question: "What did you use for the AI interviewer's voice in Hiremind?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, true, `Should pass when acknowledging limitation: ${JSON.stringify(res.violations)}`);
    });

    test('Inventing ElevenLabs on top of partial architecture is caught and flagged', () => {
      const mixedAnswer = "In Hiremind AI, the AI interviewer uses real-time speech generation powered by ElevenLabs, streamed over WebSockets from our FastAPI backend.";

      const res = validateProfileEvidence({
        answer: mixedAnswer,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_PARTIAL,
        question: "What did you use for the AI interviewer's voice in Hiremind?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, false);
      assert.ok(res.errorCodes.includes('unsupported_implementation'));
      assert.ok(res.violations.some(v => v.detail.toLowerCase().includes('elevenlabs')));
    });
  });

  // Test E — Unsupported metrics
  // Context: No latency, accuracy, or performance metric is documented.
  // Expected: The answer does not invent numerical metrics.
  describe('Test E — Unsupported metrics', () => {
    const HIREMIND_DOCS_NO_METRICS = `<personal_context>
[Project: Hiremind AI]
Platform for automated technical interviews built with FastAPI and React.
Candidates answer screening questions and the system provides rubric evaluations.
</personal_context>`;

    test('An answer inventing ungrounded metrics (45% reduction, 99.2% accuracy) is flagged', () => {
      const answerWithFabricatedMetrics = "We optimized Hiremind AI so that it reduced audio latency by 45% and achieved 99.2% accuracy in scoring.";

      const res = validateProfileEvidence({
        answer: answerWithFabricatedMetrics,
        plan: makePlan(),
        evidence: HIREMIND_DOCS_NO_METRICS,
        question: "What performance metrics did you achieve in Hiremind AI?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, false);
      assert.ok(res.errorCodes.includes('unsupported_metric'), 'Must flag unsupported metrics');
    });

    test('An answer with documented metrics passes validation', () => {
      const DOCS_WITH_METRIC = `<personal_context>
[Project: Hiremind AI]
Reduced audio latency by 35% using local caching.
</personal_context>`;

      const groundedAnswer = "In Hiremind AI, we reduced audio latency by 35% through caching.";

      const res = validateProfileEvidence({
        answer: groundedAnswer,
        plan: makePlan(),
        evidence: DOCS_WITH_METRIC,
        question: "What metrics did you achieve?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, true, `Documented metric must pass: ${JSON.stringify(res.violations)}`);
    });
  });

  // Test F — Follow-up questions
  // Ask: "Why did you choose ElevenLabs?" when there is no evidence that ElevenLabs was used.
  // Expected: The system challenges the unsupported premise instead of fabricating a reason for choosing it.
  describe('Test F — Follow-up questions (premise challenge)', () => {
    const HIREMIND_DOCS = `<personal_context>
[Project: Hiremind AI]
Automated interview application. Backend in FastAPI, frontend in React.
</personal_context>`;

    test('analyzeEvidenceGrounding identifies premise and creates PREMISE CHALLENGE directive', () => {
      const q = "Why did you choose ElevenLabs?";
      const analysis = analyzeEvidenceGrounding({
        question: q,
        evidence: HIREMIND_DOCS,
        answerType: 'project_followup_answer',
      });

      assert.equal(analysis.hasPresupposition, true);
      assert.ok(analysis.unsupportedEntities.includes('elevenlabs'));
      assert.ok(
        analysis.groundingDirectives.some(d => d.includes('PREMISE CHALLENGE') && d.includes('Challenge the premise')),
        'Must generate premise challenge directive'
      );
    });

    test('If model fabricates a justification for ElevenLabs, validator flags it', () => {
      const fabricatedAnswer = "I chose ElevenLabs because of its realistic voice synthesis and low-latency streaming API.";
      const res = validateProfileEvidence({
        answer: fabricatedAnswer,
        plan: makePlan({ answerType: 'project_followup_answer' }),
        evidence: HIREMIND_DOCS,
        question: "Why did you choose ElevenLabs?",
        profileAvailable: true,
        candidateDirected: true,
      });

      assert.equal(res.ok, false);
      assert.ok(res.errorCodes.includes('unsupported_implementation'));
    });

    test('qualifyUnsupportedImplementationClaims converts fabricated justification into premise challenge', () => {
      const fabricatedAnswer = "I chose ElevenLabs because it offered high voice quality.";
      const qualified = qualifyUnsupportedImplementationClaims(fabricatedAnswer, ['elevenlabs'], {
        question: "Why did you choose ElevenLabs?",
      });

      assert.match(qualified, /does not document using elevenlabs/i);
      assert.ok(!qualified.includes('offered high voice quality'));
    });
  });

  // Test G — Personal Context versus general knowledge
  // Ask: "How does text-to-speech work generally?"
  // Expected: The system can explain text-to-speech using general technical knowledge without falsely attributing a particular implementation to my project.
  describe('Test G — Personal Context versus general knowledge', () => {
    const EMPTY_CONTEXT = `<personal_context>\nNo documents uploaded.\n</personal_context>`;

    test('isGeneralTechnicalQuestion classifies conceptual question as general technical', () => {
      assert.equal(isGeneralTechnicalQuestion("How does text-to-speech work generally?"), true);
      assert.equal(isGeneralTechnicalQuestion("What is Whisper and how does it process audio?"), true);
      assert.equal(isGeneralTechnicalQuestion("Explain how neural vocoders work"), true);
      // Personal questions must NOT be general
      assert.equal(isGeneralTechnicalQuestion("What did you use for the voice in your project?"), false);
      assert.equal(isGeneralTechnicalQuestion("Did you use ElevenLabs in Hiremind?"), false);
    });

    test('General technical explanation mentioning ElevenLabs and Whisper without personal claim passes', () => {
      const q = "How does text-to-speech work generally?";
      const generalAnswer = "Text-to-speech typically converts text into phonemes, synthesizes mel-spectrograms with an acoustic model, and uses neural vocoders to produce audio waveforms. Modern commercial services like ElevenLabs and Whisper utilize large transformer models to achieve high realism.";

      const detection = detectUnsupportedImplementationClaims(generalAnswer, EMPTY_CONTEXT, q);
      assert.equal(detection.unsupportedClaims.length, 0, 'General explanation must not be flagged as unsupported personal claim');
    });

    test('If general question answer falsely claims personal implementation, validator still catches it', () => {
      const q = "How does text-to-speech work generally?";
      const answerWithFalseClaim = "TTS works by acoustic modeling and neural vocoders. In my project Hiremind AI, I used ElevenLabs for the voice.";

      const detection = detectUnsupportedImplementationClaims(answerWithFalseClaim, EMPTY_CONTEXT, q);
      assert.ok(detection.unsupportedClaims.includes('elevenlabs'), 'False personal implementation in general answer must be caught');
    });
  });

  // Test H — Provider consistency
  // Run the same grounding tests through typed chat, What To Answer, and LiteLLM/OpenRouter.
  // Expected: All paths follow the same personal-fact grounding policy.
  describe('Test H — Provider consistency across answer paths', () => {
    const HIREMIND_DOCS = `<personal_context>
[Project: Hiremind AI]
Automated interview application. Backend in FastAPI, PostgreSQL.
</personal_context>`;

    test('buildPersonalContextPromptBlock injects canonical grounding policy and stage-4 directives', () => {
      const block = buildPersonalContextPromptBlock(HIREMIND_DOCS, {
        question: "What did you use for the AI interviewer's voice?",
        answerPlan: { answerType: 'project_answer' },
      });

      assert.match(block, /<personal_context_grounding_policy>/);
      assert.match(block, /AUTHORITATIVE EVIDENCE/);
      assert.match(block, /NO INVENTED IMPLEMENTATIONS/);
      assert.match(block, /NO INFERRED STACKS/);
      assert.match(block, /PREMISE CHALLENGE ON FOLLOW-UPS/);
      assert.match(block, /<grounded_evidence_guidance>/);
      assert.match(block, /MISSING VOICE PROVIDER/);
    });

    test('WhatToAnswerLLM prompt pipeline contains strict grounding policy regardless of provider', async () => {
      // Stub helper to echo prompt (provider agnostic)
      let receivedPrompt = '';
      const stubHelper = {
        getPromptTier: () => 'tiny',
        getCapabilities: () => ({ outputBudgetTokens: 1000 }),
        fitContextForCurrentModel: (t) => t,
        canUseLocalFallback: async () => false,
        async *streamChat(userMessage) {
          receivedPrompt = userMessage;
          yield 'streamed';
        },
      };

      const stubModes = {
        getActiveModeSystemPromptSuffix: () => '',
        buildActiveModeContextBlock: () => '',
        buildRetrievedActiveModeContextBlock: () => '',
      };

      const wta = new WhatToAnswerLLM(stubHelper, stubModes);
      const personalContext = HIREMIND_DOCS;
      const question = "What did you use for the AI interviewer's voice in Hiremind?";

      // Drive generateStream through WhatToAnswerLLM with personalContext at index 13
      for await (const _ of wta.generateStream(
        `[INTERVIEWER]: ${question}`,
        undefined, // temporalContext
        { intent: 'project_answer', answerShape: 'x' }, // intentResult
        undefined, // imagePaths
        undefined, // screenContext
        undefined, // promptInstruction
        undefined, // activeSkill
        undefined, // domContext
        undefined, // candidateProfile
        makePlan({
          answerType: 'project_answer',
          requiredContextLayers: [],
          forbiddenContextLayers: [],
          responseTemplate: '',
        }), // answerPlan
        undefined, // preFetchedModeContext
        undefined, // requestSnapshot
        personalContext, // personalContext (param 13)
      )) {}

      assert.match(receivedPrompt, /personal_context_grounding_policy/, 'WhatToAnswer prompt must contain grounding policy');
      assert.match(receivedPrompt, /MISSING VOICE PROVIDER/, 'WhatToAnswer prompt must contain voice provider directive');
    });

    test('Observability logger records audit trail safely without secrets', () => {
      let loggedOutput = null;
      const originalLog = console.log;
      console.log = (...args) => {
        if (args[0] === '[PersonalFactGrounding] Trace') {
          loggedOutput = args[1];
        }
      };

      try {
        logPersonalFactGroundingObservability({
          path: 'what_to_answer',
          provider: 'litellm/openrouter',
          question: "What did you use for the AI interviewer's voice?",
          sourcesRetrieved: ['Hiremind_AI_Overview.md'],
          supportedEntities: ['FastAPI', 'PostgreSQL'],
          unsupportedEntities: ['ElevenLabs'],
          missingAspects: 'voice_generation_provider',
          groundingValidationRan: true,
          unsupportedClaimsDetected: ['ElevenLabs'],
          actionTaken: 'qualified',
        });

        assert.ok(loggedOutput !== null, 'Trace must be emitted');
        assert.equal(loggedOutput.path, 'what_to_answer');
        assert.equal(loggedOutput.provider, 'litellm/openrouter');
        assert.equal(loggedOutput.actionTaken, 'qualified');
        assert.equal(loggedOutput.missingAspects, 'voice_generation_provider');
        // Verify no credentials or API keys logged
        const str = JSON.stringify(loggedOutput);
        assert.ok(!str.includes('sk-'));
        assert.ok(!str.includes('Bearer'));
      } finally {
        console.log = originalLog;
      }
    });
  });
});
