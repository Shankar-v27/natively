// electron/llm/personalFactGrounding.ts
//
// Strict Personal Context Grounding Policy & Validation
//
// Ensures that all candidate-specific claims (projects, implementations,
// technology stacks, APIs, external services, speech/voice providers,
// technical decisions, metrics, and achievements) are grounded exclusively
// in uploaded Personal Context documents and authorized profile facts.
//
// General LLM knowledge is permitted for explaining technical concepts,
// but MUST NEVER be used to invent or infer personal implementation history.

import type { AnswerType } from './AnswerPlanner';

export interface EvidenceGroundingAnalysis {
  isPersonalImplementationAsk: boolean;
  isGeneralTechnicalAsk: boolean;
  requestedEntities: string[];
  supportedEntities: string[];
  unsupportedEntities: string[];
  hasPresupposition: boolean;
  missingAspect: string | null;
  groundingDirectives: string[];
}

export interface UnsupportedClaimDetectionResult {
  unsupportedClaims: string[];
  details: string[];
}

export interface ObservabilityLogData {
  path: 'what_to_answer' | 'typed_chat' | 'voice_trigger' | 'test';
  provider?: string;
  question?: string;
  sourcesRetrieved?: string[];
  supportedEntities?: string[];
  unsupportedEntities?: string[];
  missingAspects?: string | null;
  groundingValidationRan: boolean;
  unsupportedClaimsDetected?: string[];
  actionTaken: 'none' | 'qualified' | 'repaired';
}

// Common tech words and stopwords that should not be treated as third-party providers/tools
const STOP_TECH_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'using', 'and', 'or', 'but',
  'my', 'our', 'your', 'this', 'that', 'these', 'those', 'some', 'many', 'all', 'each', 'every',
  'clean', 'solid', 'rest', 'api', 'apis', 'crud', 'mvc', 'architecture', 'design', 'pattern',
  'patterns', 'system', 'systems', 'backend', 'frontend', 'full', 'stack', 'database', 'databases',
  'cache', 'caching', 'queue', 'queues', 'worker', 'workers', 'service', 'services', 'server',
  'servers', 'client', 'clients', 'model', 'models', 'pipeline', 'pipelines', 'algorithm', 'algorithms',
  'logic', 'code', 'data', 'state', 'store', 'storage', 'memory', 'disk', 'network', 'http', 'https',
  'tcp', 'udp', 'websocket', 'websockets', 'ocr', 'stt', 'tts', 'ai', 'ml', 'nlp', 'llm', 'llms',
  'latency', 'throughput', 'scale', 'scaling', 'load', 'balancer', 'balancing', 'unit', 'test',
  'testing', 'integration', 'git', 'linux', 'mac', 'windows', 'docker', 'cloud', 'local',
  'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'c++', 'c#', 'html', 'css', 'sql',
  'voice', 'speech', 'audio', 'interviewer', 'candidate', 'interview', 'recruitment', 'automation'
]);

// Well-known third-party external services, speech/voice providers, vector stores, and model APIs
const KNOWN_THIRD_PARTY_TOOLS = [
  'elevenlabs', 'whisper', 'openai whisper', 'azure speech', 'aws polly', 'deepgram',
  'playht', 'cartesia', 'tortoise', 'bark', 'vall-e', 'coqui', 'speechify', 'resemble ai',
  'openai', 'gpt-4', 'gpt-4o', 'claude', 'anthropic', 'gemini', 'mistral', 'llama',
  'cohere', 'groq', 'together ai', 'replicate', 'huggingface', 'deepseek',
  'pinecone', 'weaviate', 'qdrant', 'chroma', 'milvus', 'faiss', 'langchain', 'llamaindex',
  'haystack', 'crewai', 'autogen', 'supabase', 'firebase', 'mongodb', 'postgresql', 'postgres',
  'redis', 'mysql', 'dynamodb', 'cassandra', 'neo4j', 'prisma', 'typeorm'
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Check if the question is asking about a general technical concept without candidate ownership */
export function isGeneralTechnicalQuestion(question: string): boolean {
  const q = (question || '').trim().toLowerCase();
  if (!q) return false;
  const isGeneralPhrasing = /^(?:how does|what is|what are|explain|explain how|define|describe how|can you explain|walk me through how|why do we|why is)\b/i.test(q);
  const hasPersonalRef = /\b(?:your|yours|my|mine|our|ours|you|i|we)\b/i.test(q) ||
                         /\b(?:did you|have you|did i|have i|in your|in my|built|created|implemented|worked on)\b/i.test(q);
  return isGeneralPhrasing && !hasPersonalRef;
}

/** Extract explicit technology or service names mentioned in a query */
export function extractQueriedTechnologies(question: string): string[] {
  const q = question || '';
  const found: string[] = [];
  const qLower = q.toLowerCase();

  for (const tool of KNOWN_THIRD_PARTY_TOOLS) {
    const re = new RegExp(`\\b${escapeRegExp(tool)}\\b`, 'i');
    if (re.test(qLower)) {
      found.push(tool);
    }
  }

  // Also match capitalized proper nouns that look like technology names
  const matches = q.match(/\b[A-Z][a-zA-Z0-9]*(?:[ -][A-Z][a-zA-Z0-9]+)*\b/g) || [];
  for (const m of matches) {
    const lc = m.toLowerCase();
    if (!STOP_TECH_WORDS.has(lc) && !found.some(f => f.toLowerCase() === lc)) {
      if (m.length > 2) {
        found.push(m);
      }
    }
  }

  return Array.from(new Set(found));
}

/**
 * Checks whether an entity is present in evidence as an implemented technology
 * versus merely discussed in a comparison, future work, or alternative.
 */
export function isEntityDocumentedAsImplemented(entity: string, evidence: string): {
  documented: boolean;
  isFutureOrComparisonOnly: boolean;
} {
  if (!entity || !evidence) {
    return { documented: false, isFutureOrComparisonOnly: false };
  }

  const evLower = evidence.toLowerCase();
  const entLower = entity.toLowerCase();

  // Word boundary regex
  const entRegex = new RegExp(`\\b${escapeRegExp(entLower)}\\b`, 'i');
  if (!entRegex.test(evLower)) {
    return { documented: false, isFutureOrComparisonOnly: false };
  }

  // Check if every mention of the entity in the evidence occurs strictly within
  // future work, planned, alternative, or comparison contexts.
  const futureOrComparisonPatterns = [
    new RegExp(`(?:future(?:\\s+work)?|planned|not\\s+(?:yet\\s+)?implemented|todo|roadmap|upcoming|next\\s+steps?|evaluating|considering)\\s*[:\\-–—]?\\s*[^.\\n]*?\\b${escapeRegExp(entLower)}\\b`, 'gi'),
    new RegExp(`(?:compared\\s+(?:to|with|against)|comparison|alternative(?:s)?\\s+(?:considered)?|versus|vs\\.?)\\s*[:\\-–—]?\\s*[^.\\n]*?\\b${escapeRegExp(entLower)}\\b`, 'gi'),
    new RegExp(`\\b${escapeRegExp(entLower)}\\b[^.\\n]*?\\b(?:in\\s+(?:a\\s+)?comparison|in\\s+future|planned|not\\s+(?:yet\\s+)?implemented|not\\s+in\\s+(?:the\\s+)?implementation|was\\s+considered|evaluated(?:\\s+against)?|alternative|future-work|future\\s+work|future\\s+release)\\b`, 'gi'),
    new RegExp(`\\b(?:mention(?:s|ed)?|discuss(?:es|ed)?)\\s+[^.\\n]*?\\b${escapeRegExp(entLower)}\\b[^.\\n]*?\\b(?:in\\s+(?:a\\s+)?comparison|future-work|future\\s+work)\\b`, 'gi'),
  ];

  // Also check if matches fall under markdown headings that represent future work or comparisons
  const matches = Array.from(evidence.matchAll(new RegExp(`\\b${escapeRegExp(entLower)}\\b`, 'gi')));
  const totalOccurrences = matches.length;
  let nonImplOccurrences = 0;

  for (const m of matches) {
    const idx = m.index ?? 0;
    // Check preceding heading
    const textBefore = evidence.slice(0, idx);
    const headings = Array.from(textBefore.matchAll(/^#{1,6}\s+([^\n]+)$/gm));
    let inNonImplSection = false;
    if (headings.length > 0) {
      const lastHeading = headings[headings.length - 1][1].toLowerCase();
      if (/(?:future(?:\s*work)?|roadmap|upcoming|planned|comparison|alternative|not\s+implemented|evaluat|benchmark|ideas|wishlist)/i.test(lastHeading)) {
        inNonImplSection = true;
      }
    }

    // Check line/sentence context
    const lineStart = Math.max(0, evidence.lastIndexOf('\n', idx));
    const lineEnd = evidence.indexOf('\n', idx);
    const line = evidence.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).toLowerCase();
    const isLineComparison = /(?:future|planned|roadmap|comparison|compared|alternative|considered|not\s+implemented|not\s+in\s+the\s+implementation)/i.test(line);

    if (inNonImplSection || isLineComparison) {
      nonImplOccurrences++;
    }
  }

  // Also check pattern matches if heading didn't cover
  let patternNonImpl = 0;
  for (const p of futureOrComparisonPatterns) {
    const m = evLower.match(p);
    if (m) patternNonImpl += m.length;
  }
  const effectiveNonImpl = Math.max(nonImplOccurrences, patternNonImpl);

  if (totalOccurrences > 0 && effectiveNonImpl >= totalOccurrences) {
    return { documented: true, isFutureOrComparisonOnly: true };
  }

  return { documented: true, isFutureOrComparisonOnly: false };
}

/**
 * Stage 4: Analyze Evidence Grounding
 * Evaluates the question and retrieved evidence before final answer generation.
 */
export function analyzeEvidenceGrounding(options: {
  question: string;
  evidence: string;
  answerType?: AnswerType;
}): EvidenceGroundingAnalysis {
  const { question, evidence } = options;
  const qLower = (question || '').toLowerCase();
  const isGeneralTech = isGeneralTechnicalQuestion(question);

  const isPersonalAsk = !isGeneralTech && (
    /\b(?:your|my|our|you|i|we)\b/i.test(question) ||
    /\b(?:project|built|developed|implemented|used|stack|architecture|voice|interviewer|hiremind)\b/i.test(question) ||
    options.answerType === 'project_answer' ||
    options.answerType === 'project_followup_answer' ||
    options.answerType === 'experience_answer' ||
    options.answerType === 'skill_experience_answer'
  );

  const queriedTechs = extractQueriedTechnologies(question);
  const supported: string[] = [];
  const unsupported: string[] = [];

  for (const tech of queriedTechs) {
    const status = isEntityDocumentedAsImplemented(tech, evidence);
    if (status.documented && !status.isFutureOrComparisonOnly) {
      supported.push(tech);
    } else {
      unsupported.push(tech);
    }
  }

  // Detect presuppositions like "Why did you choose ElevenLabs?"
  const hasPresupposition = /\b(?:why|how)\s+did\s+(?:you|we|i)\s+(?:choose|pick|select|use|decide\s+on)\b/i.test(qLower) &&
                            unsupported.length > 0;

  // Detect specific queries for voice / speech providers where context is partial
  let missingAspect: string | null = null;
  const asksVoiceProvider = /\b(?:voice|speech(?:\s+generation)?|interviewer'?s?\s+voice|text[- ]to[- ]speech|tts)\b/i.test(qLower);
  if (asksVoiceProvider) {
    // Check if evidence mentions a voice provider
    const hasVoiceProviderInEvidence = ['elevenlabs', 'whisper', 'polly', 'azure speech', 'deepgram', 'playht', 'cartesia'].some(
      v => isEntityDocumentedAsImplemented(v, evidence).documented
    );
    if (!hasVoiceProviderInEvidence) {
      missingAspect = 'voice_generation_provider';
    }
  }

  const directives: string[] = [];

  if (isPersonalAsk) {
    if (unsupported.length > 0) {
      for (const un of unsupported) {
        if (hasPresupposition) {
          directives.push(
            `- PREMISE CHALLENGE: The question assumes "${un}" was used, but "${un}" is NOT documented in your project context. Challenge the premise honestly instead of fabricating a justification (e.g. "Actually, my project context does not document using ${un}...").`
          );
        } else {
          directives.push(
            `- UNSUPPORTED TOOL: "${un}" is NOT documented as implemented in your project context. Do NOT claim that "${un}" was implemented or used.`
          );
        }
      }
    }

    if (missingAspect === 'voice_generation_provider') {
      directives.push(
        `- MISSING VOICE PROVIDER: The specific voice-generation provider is NOT documented in your project context. Do NOT invent ElevenLabs, OpenAI, Whisper, Azure, or any other provider. Acknowledge this limitation naturally (e.g., "I don't have the exact voice-generation provider documented in my project context, so I don't want to guess. I can explain the architecture that is documented, but I would need to verify the specific provider.") and explain the documented architecture.`
      );
    }
  }

  return {
    isPersonalImplementationAsk: isPersonalAsk,
    isGeneralTechnicalAsk: isGeneralTech,
    requestedEntities: queriedTechs,
    supportedEntities: supported,
    unsupportedEntities: unsupported,
    hasPresupposition,
    missingAspect,
    groundingDirectives: directives,
  };
}

/**
 * Detect claims in an answer that assert candidate/project implementation
 * of an unsupported technology, model, library, or API.
 */
export function detectUnsupportedImplementationClaims(
  answer: string,
  evidence: string,
  question?: string
): UnsupportedClaimDetectionResult {
  const text = (answer || '').trim();
  if (!text) return { unsupportedClaims: [], details: [] };

  // If question was purely general technical AND answer does not make candidate implementation claims, skip
  const hasPersonalImplementationInAnswer = /\b(?:I|we|my project|our project|Hiremind|in my project|for my project)\s+(?:used|uses|implemented|implements|integrated|chose|selected|built)\b/i.test(text);
  if (question && isGeneralTechnicalQuestion(question) && !hasPersonalImplementationInAnswer) {
    return { unsupportedClaims: [], details: [] };
  }

  const unsupportedClaims: string[] = [];
  const details: string[] = [];
  const evLower = (evidence || '').toLowerCase();

  // Pattern 1: Direct first-person / project implementation verbs
  // "I used <X>", "we implemented <X>", "my project uses <X>", "Hiremind uses <X>"
  const implClaimRegex = /\b(?:I|we|my project|our project|Hiremind|the project|the app|the system)\s+(?:used|uses|implemented|implements|integrated|integrates|chose|selected|relied on|relies on|leveraged|adopted|utilized|configured|deployed|built\s+with|built\s+using)\s+([A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*)\b/g;

  // Pattern 1b: Implementation via / with phrases
  const implWithRegex = /\b(?:I|we|my project|our project|Hiremind)\s+[^.\n]{0,35}?\b(?:using|with|via)\s+([A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*)\b/g;

  // Pattern 2: Component implementation attribution
  // "the voice is powered by <X>", "speech generation is handled by <X>", "built using <X>"
  const componentClaimRegex = /\b(?:voice|speech|audio|tts|stt|transcription|backend|database|vector store)\s+(?:is|was|are|were)?\s*(?:powered by|handled by|generated by|built with|implemented with|using|via)\s+([A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*)\b/gi;

  const candidateEntities = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = implClaimRegex.exec(text)) !== null) {
    const ent = m[1].trim().replace(/[.,!?;:]$/, '');
    if (ent && !STOP_TECH_WORDS.has(ent.toLowerCase()) && ent.length > 2) {
      candidateEntities.add(ent);
    }
  }

  while ((m = implWithRegex.exec(text)) !== null) {
    const ent = m[1].trim().replace(/[.,!?;:]$/, '');
    if (ent && !STOP_TECH_WORDS.has(ent.toLowerCase()) && ent.length > 2) {
      candidateEntities.add(ent);
    }
  }

  while ((m = componentClaimRegex.exec(text)) !== null) {
    const ent = m[1].trim().replace(/[.,!?;:]$/, '');
    if (ent && !STOP_TECH_WORDS.has(ent.toLowerCase()) && ent.length > 2) {
      candidateEntities.add(ent);
    }
  }

  // Pattern 3: Explicit mentions of known third-party tools claimed as used
  for (const tool of KNOWN_THIRD_PARTY_TOOLS) {
    const toolRegex = new RegExp(`\\b${escapeRegExp(tool)}\\b`, 'i');
    if (toolRegex.test(text)) {
      // Check if it is framed as implemented by candidate ("used ElevenLabs", "ElevenLabs for the voice", "with Whisper")
      const personalContextFrame = new RegExp(
        `\\b(?:(?:I|we|project|Hiremind|voice|speech|interviewer)\\s+[^.\\n]{0,40}\\b${escapeRegExp(tool)}\\b|\\b${escapeRegExp(tool)}\\b[^.\\n]{0,40}\\b(?:for\\s+the\\s+voice|for\\s+speech|was\\s+used|was\\s+chosen|because|to\\s+generate))\\b`,
        'i'
      );
      if (personalContextFrame.test(text)) {
        candidateEntities.add(tool);
      }
    }
  }

  // Validate each claimed entity against the grounded evidence
  for (const ent of candidateEntities) {
    const status = isEntityDocumentedAsImplemented(ent, evidence);
    if (!status.documented || status.isFutureOrComparisonOnly) {
      unsupportedClaims.push(ent);
      details.push(
        status.isFutureOrComparisonOnly
          ? `entity "${ent}" is only documented in future/comparison context, not as implemented`
          : `technology/service "${ent}" is absent from the grounded evidence`
      );
    }
  }

  return { unsupportedClaims, details };
}

/**
 * Deterministically qualifies or replaces unsupported implementation claims
 * in an answer to ensure the user-facing response remains truthful and interview-ready.
 */
export function qualifyUnsupportedImplementationClaims(
  answer: string,
  unsupportedClaims: string[],
  options?: { question?: string }
): string {
  if (!answer || unsupportedClaims.length === 0) return answer;

  const qLower = (options?.question || '').toLowerCase();
  let modified = answer;

  // Case 1: Premise challenge (e.g. "Why did you choose ElevenLabs?")
  const isPremiseAsk = /\b(?:why|how)\s+did\s+(?:you|we|i)\s+(?:choose|pick|select|use)\b/i.test(qLower);
  if (isPremiseAsk) {
    const missingTools = unsupportedClaims.join(', ');
    return `Actually, my project documentation does not document using ${missingTools} for this project, so I don't have a record of selecting it. I can explain the architecture and technologies that are documented in my project context.`;
  }

  // Case 2: Voice/speech provider was unsupported
  const isVoiceRelated = /\b(?:voice|speech|tts|audio|interviewer'?s?\s+voice)\b/i.test(qLower) ||
                         unsupportedClaims.some(c => /elevenlabs|whisper|polly|azure speech|playht|deepgram/i.test(c));

  if (isVoiceRelated) {
    // Replace sentences claiming the unsupported provider with an honest qualification
    const sentences = modified.split(/(?<=[.!?])\s+/);
    const cleanedSentences = sentences.map(s => {
      const containsUnsupported = unsupportedClaims.some(c => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(s));
      if (containsUnsupported) {
        return "I don't have the exact voice-generation provider documented in my project context, so I don't want to guess. I can explain the architecture that is documented, but I would need to verify the specific provider.";
      }
      return s;
    });
    modified = cleanedSentences.join(' ');
  } else {
    // General unsupported claim qualification
    for (const claim of unsupportedClaims) {
      const claimRegex = new RegExp(`\\b(?:I|we|my project)\\s+(?:used|implemented|chose|integrated)\\s+${escapeRegExp(claim)}\\b[^.!?]*[.!?]?`, 'gi');
      modified = modified.replace(claimRegex, `I don't have ${claim} documented in my project context, so I would need to verify that specific tool.`);
    }
  }

  return modified.trim();
}

/**
 * Shared canonical block builder for Personal Context with strict grounding policy.
 */
export function buildPersonalContextPromptBlock(
  personalContext: string,
  options?: { question?: string; answerPlan?: any }
): string {
  const safeContext = (personalContext || '').replace(/<(\/?)personal_context(_rules|_grounding_policy)?>/gi, '‹$1personal_context$2›');
  const question = options?.question || '';

  // Run stage 4 evidence-grounding analysis if question is provided
  let guidanceBlock = '';
  if (question.trim()) {
    const analysis = analyzeEvidenceGrounding({
      question,
      evidence: personalContext,
      answerType: options?.answerPlan?.answerType,
    });

    if (analysis.groundingDirectives.length > 0) {
      guidanceBlock = `\n<grounded_evidence_guidance>\n${analysis.groundingDirectives.join('\n')}\n</grounded_evidence_guidance>`;
    }
  }

  return `<personal_context>
${safeContext}
</personal_context>
<personal_context_grounding_policy>
1. AUTHORITATIVE EVIDENCE: Personal Context and uploaded candidate facts are the SOLE authoritative source for what the candidate personally built, implemented, used, or decided.
2. NO INVENTED IMPLEMENTATIONS: Never state or imply that a technology, model, library, framework, database, API, external service, or provider was implemented or used unless explicitly confirmed by the retrieved evidence.
3. NO INFERRED STACKS: Do not infer technologies from industry standards, common patterns, or project names. Knowing a project does voice synthesis, AI interviewing, or vector search is NOT evidence that it uses ElevenLabs, Whisper, Pinecone, or any specific provider.
4. STATUS DISTINCTION: Preserve the strict distinction between what was implemented vs planned, experimented with, or merely compared. Mention of a tool in a comparison or future-work note is NOT evidence of implementation.
5. HONEST MISSING DETAILS: If an implementation detail, provider, or technical choice is requested but not documented in context, acknowledge that limitation naturally (e.g., "I don't have the exact provider documented in my project context, so I don't want to guess. I can explain the architecture that is documented, but I would need to verify the specific provider") instead of guessing. Answer the documented portions and qualify only what is missing.
6. PREMISE CHALLENGE ON FOLLOW-UPS: If a question asks why or how a specific technology was chosen (e.g. "Why did you choose ElevenLabs?") when that technology is not in your context, challenge the unsupported premise directly rather than fabricating a justification.
7. GENERAL KNOWLEDGE SEPARATION: You may use general technical knowledge to explain concepts (e.g., how TTS or Whisper works in general), but never claim or imply that the candidate used or implemented it without documentary evidence.
8. METRICS: Never invent metrics, percentages, speedups, or numbers not in the evidence.
</personal_context_grounding_policy>${guidanceBlock}`;
}

/** Observability logging helper for personal-fact grounding */
export function logPersonalFactGroundingObservability(data: ObservabilityLogData): void {
  try {
    console.log('[PersonalFactGrounding] Trace', {
      path: data.path,
      provider: data.provider || 'unknown',
      questionSnippet: data.question ? data.question.slice(0, 80) : undefined,
      sourcesCount: data.sourcesRetrieved?.length || 0,
      supportedEntities: data.supportedEntities || [],
      unsupportedEntities: data.unsupportedEntities || [],
      missingAspects: data.missingAspects || null,
      groundingValidationRan: data.groundingValidationRan,
      unsupportedClaimsDetected: data.unsupportedClaimsDetected || [],
      actionTaken: data.actionTaken,
    });
  } catch {
    // Non-fatal logging
  }
}
