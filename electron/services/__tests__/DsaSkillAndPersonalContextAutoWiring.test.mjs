import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('DSA Skill and Personal Context Auto-wiring', () => {
  test('SkillsManager declares findMatchingSkill', () => {
    const source = read('electron/services/SkillsManager.ts');
    assert.match(source, /public findMatchingSkill\(query: string\): SkillDetails \| null/,
      'SkillsManager must declare findMatchingSkill');
    assert.match(source, /dsa\|leetcode\|coding\|interview-strict/i,
      'findMatchingSkill must have dsa skill heuristics');
    assert.ok(source.includes('open[- ]?source'),
      'findMatchingSkill must have open source heuristics');
    assert.match(source, /project/i,
      'findMatchingSkill must have project heuristics');
  });

  test('PersonalContextService declares getDocumentContentByPattern and keyword fallback', () => {
    const source = read('electron/services/PersonalContextService.ts');
    assert.match(source, /public getDocumentContentByPattern\(pattern: string\): string/,
      'PersonalContextService must declare getDocumentContentByPattern');
    assert.match(source, /matchedDocPattern\s*=\s*'dsa'/,
      'retrieveRelevantContext must include DSA keyword fallback');
  });

  test('resolvePersonalContextForAnswer supports DSA personal context', () => {
    const source = read('electron/llm/resolvePersonalContext.ts');
    assert.match(source, /getDocumentContentByPattern\('dsa'\)/,
      'resolvePersonalContextForAnswer must check for DSA personal context document');
  });

  test('manualChatEnrichment resolves personal context for isCodingChat', () => {
    const source = read('electron/llm/manualChatEnrichment.ts');
    assert.match(source, /if\s*\(isCodingChat\)\s*\{[\s\S]*resolvePersonalContextForAnswer/,
      'enrichManualChatContext must resolve personal context when isCodingChat is true');
  });

  test('ipcHandlers auto-matches skill, injects DSA personal context, and sets dsa_question_answer', () => {
    const source = read('electron/ipcHandlers.ts');
    assert.match(source, /findMatchingSkill\(queryForSkill\)/,
      'gemini-chat-stream must call findMatchingSkill when !skillPromptBlock');
    assert.match(source, /getDocumentContentByPattern\('dsa'\)/,
      'gemini-chat-stream must check for DSA personal context document');
    assert.match(source, /answerPlan\.answerType\s*=\s*'dsa_question_answer'/,
      'gemini-chat-stream must align answerType to dsa_question_answer for DSA turns');
    assert.match(source, /dsaPersonalContextBlock[\s\S]*skillPromptBlock/,
      'gemini-chat-stream must inject both dsaPersonalContextBlock and skillPromptBlock into context');
  });

  test('generate-what-to-say auto-matches skill when no active skill is set', () => {
    const source = read('electron/ipcHandlers.ts');
    assert.match(source, /findMatchingSkill\(queryText\)/,
      'generate-what-to-say must fallback to findMatchingSkill when getActiveSkillPayload is null');
  });
});
