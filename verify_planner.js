const { planAnswer, detectAnswerStyle } = require('./electron/llm/AnswerPlanner.ts');
const fs = require('fs');
const tsNode = require('ts-node');

tsNode.register({
  compilerOptions: { module: 'commonjs' }
});

const AnswerPlanner = require('./electron/llm/AnswerPlanner.ts');

const testCases = [
  "Introduce yourself",
  "Tell me about Signly",
  "Tell me about Drake",
  "What is overfitting?",
  "How does RAG work?",
  "Longest substring without repeating characters",
  "Write SQL to find the second highest salary",
  "Design a URL shortener"
];

for (const q of testCases) {
  const plan = AnswerPlanner.planAnswer({
    question: q,
    source: 'what_to_answer',
    speakerPerspective: 'interviewer'
  });
  
  console.log(`\nQ: ${q}`);
  console.log(`Type: ${plan.answerType}`);
  console.log(`Voice: ${plan.voicePerspective}`);
  console.log(`ProfilePolicy: ${plan.profileContextPolicy}`);
  console.log(`Layers: ${plan.requiredContextLayers.join(',')}`);
  console.log(`Forbidden: ${plan.forbiddenContextLayers.join(',')}`);
}
