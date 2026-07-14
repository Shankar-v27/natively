import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '../manualChatEnrichment.ts');
const src = fs.readFileSync(srcPath, 'utf8');

// Extract the function body
const startMatch = src.match(/export async function enrichManualChatContext[^\{]+\{/);
assert.ok(startMatch, 'Could not find enrichManualChatContext in source');
const startIdx = startMatch.index + startMatch[0].length;
let endIdx = src.length - 1;
while (endIdx > startIdx && src[endIdx] !== '}') {
    endIdx--;
}
const functionBodyTS = src.slice(startIdx, endIdx);

// Transpile to JS to strip types so eval doesn't SyntaxError
const functionBodyJS = ts.transpile(functionBodyTS);

// Build an evaluator that injects the mocked dependencies
async function runPipeline(options, mocks) {
    const fn = new Function(
        'options',
        'formatAnswerPlanForPrompt',
        'humanizeDirectiveFor',
        'resolvePersonalContextForAnswer',
        'buildPersonalContextPromptBlock',
        `
        return (async () => {
            ${functionBodyJS}
        })();
        `
    );
    return fn(
        options,
        mocks.formatAnswerPlanForPrompt,
        mocks.humanizeDirectiveFor,
        mocks.resolvePersonalContextForAnswer,
        mocks.buildPersonalContextPromptBlock
    );
}

const CANDIDATE_CONTRACT_TYPES = new Set([
    'project_answer',
    'technical_concept_answer',
    'system_design_answer',
    'debugging_question_answer'
]);

describe('Manual Chat Prompt Enrichment Pipeline', () => {
    let mocks;

    beforeEach(() => {
        mocks = {
            formatAnswerPlanForPrompt: (plan) => {
                if (plan.answerType === 'technical_concept_answer') return 'TECHNICAL_INTERVIEW_ANSWER_CONTRACT';
                if (plan.answerType === 'system_design_answer') return 'SYSTEM_DESIGN_TEMPLATE';
                if (plan.answerType === 'dsa_question_answer') return 'CODING_CONTRACT';
                return 'GENERIC_CONTRACT';
            },
            humanizeDirectiveFor: () => '',
            resolvePersonalContextForAnswer: async (opts) => undefined,
            buildPersonalContextPromptBlock: (ctx) => `<personal_context>\n${ctx}\n</personal_context>\n<personal_context_rules>\n- Personal Context is authoritative for user-specific factual claims.\n</personal_context_rules>`
        };
    });

    test('What is overfitting? -> Final enriched context contains TECHNICAL_INTERVIEW_ANSWER_CONTRACT', async () => {
        const options = {
            message: 'What is overfitting?',
            answerPlan: { answerType: 'technical_concept_answer' },
            originalContext: undefined,
            isContractEnforced: false,
            isCodingChat: false,
            selectedProfileEvidence: undefined,
            CANDIDATE_CONTRACT_TYPES
        };

        const result = await runPipeline(options, mocks);
        assert.match(result || '', /TECHNICAL_INTERVIEW_ANSWER_CONTRACT/);
    });

    test('Tell me about Signly. -> Final context passed toward streamChat contains SIGNLY_UNIQUE_CONTEXT_MARKER', async () => {
        mocks.resolvePersonalContextForAnswer = async (opts) => {
            if (opts.question.includes('Signly')) return 'SIGNLY_UNIQUE_CONTEXT_MARKER';
            return undefined;
        };

        const options = {
            message: 'Tell me about Signly.',
            answerPlan: { answerType: 'project_answer' },
            originalContext: undefined,
            isContractEnforced: false,
            isCodingChat: false,
            selectedProfileEvidence: undefined,
            CANDIDATE_CONTRACT_TYPES
        };

        const result = await runPipeline(options, mocks);
        assert.match(result || '', /<personal_context>/);
        assert.match(result || '', /SIGNLY_UNIQUE_CONTEXT_MARKER/);
        assert.match(result || '', /<personal_context_rules>/);
        assert.match(result || '', /Personal Context is authoritative for user-specific factual claims/);
    });

    test('Longest substring without repeating characters -> Technical interview contract must not override CODING_CONTRACT', async () => {
        const options = {
            message: 'Longest substring without repeating characters',
            answerPlan: { answerType: 'dsa_question_answer' },
            originalContext: 'CODING_CONTRACT_INJECTED_EARLIER',
            isContractEnforced: false,
            isCodingChat: true,
            selectedProfileEvidence: undefined,
            CANDIDATE_CONTRACT_TYPES
        };

        const result = await runPipeline(options, mocks);
        assert.equal(result, 'CODING_CONTRACT_INJECTED_EARLIER');
    });

    test('Design a URL shortener -> SYSTEM_DESIGN_TEMPLATE remains active', async () => {
        const options = {
            message: 'Design a URL shortener',
            answerPlan: { answerType: 'system_design_answer' },
            originalContext: undefined,
            isContractEnforced: false,
            isCodingChat: false,
            selectedProfileEvidence: undefined,
            CANDIDATE_CONTRACT_TYPES
        };

        const result = await runPipeline(options, mocks);
        assert.match(result || '', /SYSTEM_DESIGN_TEMPLATE/);
    });
});
