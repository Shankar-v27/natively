import type { AnswerType } from './AnswerPlanner';

export interface PersonalContextQueryInput {
  question?: string;
  answerPlan: { answerType: AnswerType; resolvedEntity?: string };
  recentContext?: string;
}

/** Build the factual retrieval query from the already-extracted live question. */
export function buildPersonalContextRetrievalQuery(options: PersonalContextQueryInput): string {
  const parts: string[] = [];
  if (options.answerPlan.resolvedEntity) {
    parts.push(options.answerPlan.resolvedEntity);
  }
  if (options.question?.trim()) {
    parts.push(options.question.trim());
  }
  return parts.join(' ');
}
