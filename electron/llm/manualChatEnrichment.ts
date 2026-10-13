import { AnswerType, formatAnswerPlanForPrompt } from './AnswerPlanner';
import { humanizeDirectiveFor } from './humanLikeness';
import { resolvePersonalContextForAnswer, buildPersonalContextPromptBlock } from './resolvePersonalContext';

export interface ManualChatEnrichmentOptions {
    message: string;
    answerPlan: any;
    originalContext?: string;
    isContractEnforced: boolean;
    isCodingChat: boolean;
    selectedProfileEvidence?: string;
    CANDIDATE_CONTRACT_TYPES: Set<string>;
}

export async function enrichManualChatContext(options: ManualChatEnrichmentOptions): Promise<string | undefined> {
    const { message, answerPlan, isContractEnforced, isCodingChat, selectedProfileEvidence, CANDIDATE_CONTRACT_TYPES } = options;
    let { originalContext: context } = options;
    
    if (isCodingChat) {
        try {
            const pCtx = await resolvePersonalContextForAnswer({
                question: message,
                answerPlan,
                recentContext: context
            });
            if (pCtx) {
                const pCtxBlock = buildPersonalContextPromptBlock(pCtx, { question: message, answerPlan });
                context = context ? `${pCtxBlock}\n\n${context}` : pCtxBlock;
            }
        } catch (pcErr: any) {
            console.warn('[manualChatEnrichment] Personal context resolution failed for coding:', pcErr.message);
        }
        return context;
    }

    if (!isContractEnforced && !selectedProfileEvidence) {
        const candidateContract = formatAnswerPlanForPrompt(answerPlan, false);
        const humanize = humanizeDirectiveFor(answerPlan.answerType);
        const contractWithVoice = humanize ? `${candidateContract}\n\n${humanize}` : candidateContract;
        context = context ? `${contractWithVoice}\n\n${context}` : contractWithVoice;
        
        try {
            const pCtx = await resolvePersonalContextForAnswer({
                question: message,
                answerPlan,
                recentContext: context
            });
            if (pCtx) {
                const pCtxBlock = buildPersonalContextPromptBlock(pCtx, { question: message, answerPlan });
                context = `${pCtxBlock}\n\n${context}`;
            }
        } catch (pcErr: any) {
            console.warn('[manualChatEnrichment] Personal context resolution failed:', pcErr.message);
        }
    }
    return context;
}
