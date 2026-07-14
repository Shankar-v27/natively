import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const llm = await import(pathToFileURL(path.join(root, 'dist-electron/electron/llm/AnswerPlanner.js')).href);
const prompt = await import(pathToFileURL(path.join(root, 'dist-electron/electron/llm/prompts.js')).href);
const contract = await import(pathToFileURL(path.join(root, 'dist-electron/electron/llm/liveInterviewSpeakingContract.js')).href);
const extractor = await import(pathToFileURL(path.join(root, 'dist-electron/electron/llm/transcriptQuestionExtractor.js')).href);
const personal = await import(pathToFileURL(path.join(root, 'dist-electron/electron/llm/personalContextQuery.js')).href);
const assemblerMod = await import(pathToFileURL(path.join(root, 'dist-electron/electron/services/context/PromptAssembler.js')).href);

describe('live interview final prompt assembly', () => {
  test('the real WTA system prompt physically includes the canonical contract', () => {
    assert.ok(prompt.UNIVERSAL_WHAT_TO_ANSWER_PROMPT.includes(contract.LIVE_INTERVIEW_SPEAKING_CONTRACT));
    const packet = new assemblerMod.PromptAssembler().assemble({
      transcript: 'What is overfitting?',
      systemPrompt: prompt.UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
      intentContext: llm.formatAnswerPlanForPrompt(llm.planAnswer({ question: 'What is overfitting?', source: 'what_to_answer', speakerPerspective: 'interviewer' })),
      tokenBudget: 4000,
    });
    assert.ok(packet.systemPrompt.includes(contract.LIVE_INTERVIEW_SPEAKING_CONTRACT));
  });

  test('routes representative interview questions and preserves DSA isolation', () => {
    const cases = [
      ['What is overfitting?', 'technical_concept_answer'],
      ['How does RAG work?', 'technical_concept_answer'],
      ['Tell me about your internships.', 'experience_answer'],
      ['Tell me about Drake.', 'project_answer'],
      ['Why did you use Leiden in Drake?', 'project_followup_answer'],
      ['Tell me about Legacy.', 'project_answer'],
      ['Tell me about Signly.', 'project_answer'],
      ['Tell me about your achievements.', 'behavioral_interview_answer'],
      ['Given an array nums and target, return two sum indices.', 'dsa_question_answer'],
    ];
    for (const [question, expected] of cases) {
      const plan = llm.planAnswer({ question, source: 'what_to_answer', speakerPerspective: 'interviewer' });
      assert.equal(plan.answerType, expected, question);
      const query = personal.buildPersonalContextRetrievalQuery({ question, answerPlan: plan });
      assert.match(query, new RegExp(`AnswerType: ${expected}`));
      assert.match(query, /Extracted question:/);
      if (/Drake|Legacy|Signly/i.test(question)) assert.match(query, /Normalized entity:/, question);
    }
    const dsa = llm.formatAnswerPlanForPrompt(llm.planAnswer({ question: 'Given an array nums and target, return two sum indices.', source: 'what_to_answer', speakerPerspective: 'interviewer' }));
    assert.match(dsa, /## Approach[\s\S]*## Code[\s\S]*## Time & Space Complexity[\s\S]*## Dry Run/);
  });

  test('extracts only the latest meaningful STT question and normalizes aliases', () => {
    const raw = "Thank you. Tell me about Drake. Okay. Let's move on. What about your project Legacy? Thank you.";
    assert.equal(contract.extractLatestMeaningfulQuestionText(raw), 'What about your project Legacy?');
    const q = extractor.extractLatestQuestion([{ role: 'interviewer', text: raw, timestamp: 1 }]);
    assert.equal(q.latestQuestion, 'What about your project Legacy?');
    assert.equal(contract.normalizeInterviewEntityAliases('Tell me about sign lee and D-R-A-K-E.'), 'Tell me about SIGNLY and DRAKE.');
  });
});
