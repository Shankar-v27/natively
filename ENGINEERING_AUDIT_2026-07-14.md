# Natively — Engineering Audit (2026-07-14)

Static review only: no builds, no installs, no runtime execution. Every finding below was verified by reading the source with concrete file:line evidence. Findings are marked **[FIXED]** (implemented in this working tree, uncommitted) or **[OPEN]** (verified and specified, but deliberately not implemented because the correct fix needs staged rollout, benchmarks, or coordinated multi-file type changes that cannot be safely verified without a typecheck/run).

Line numbers reference the tree **before** this audit's edits unless noted.

---

## 0. Architecture as actually implemented (verified)

**Personal Context**: `personal-context:add-doc` → `PersonalContextService.ingestDocument()` (parse PDF/DOCX/text → heading+400-token chunking → `personal_context_docs/chunks` → background embed via shared `EmbeddingPipeline` into `vec_personal_chunks_{dim}`). At answer time `resolvePersonalContextForAnswer()` runs a regex activation gate, then sqlite-vec KNN (k = topK×5, space-filtered, threshold on `1 − distance`), and the snippet block rides inside the single user message — so **all providers receive it equally** (verified: the assembled packet flows through the provider-agnostic `streamChat` chain; the data-scope policy can scrub it for cloud and reroute to Ollama).

**Skills**: upload → validate → atomic install to `userData/skills/<id>/SKILL.md`; the ONLY live activation is the `/name` or `$name` prefix in typed overlay chat (`ipcHandlers.ts` `gemini-chat-stream`); `WhatToAnswerLLM` has complete `activeSkill` plumbing that **no caller ever feeds** (dead).

**Prompt stack**: WTA = `UNIVERSAL_WHAT_TO_ANSWER_PROMPT` + `## ACTIVE MODE` suffix + `PromptAssembler` trust-ordered user blocks. Manual chat = `CHAT_MODE_PROMPT` + inline context blocks + `<answer_contract>` for coding turns + post-stream validators. Six feature LLMs (Recap/FollowUp/Clarify/FollowUpQuestions/CodeHint/Brainstorm) use universal/tiny prompts. Screenshot solve uses its own rolling-script pipeline; a legacy "wingman" JSON pipeline survives on the debug view.

**Memory layers**: L1 rolling 120s ring → L2 durable transcript + epoch summaries (compaction >1800 segments) → L3 assistant-response history (referent-only, correct) → L4 manual conversation memory keyed by `senderId` → L5 meeting DB + `meetingMemory` insights → L6 Hindsight long-term (flag-gated, default off; live recall triple-gated and injected as `trust="low"`).

The repo's own `contextauthresearchdoc.md` (Context OS / Source Authority Kernel) correctly identifies the systemic gap: planning-layer contracts exist on manual chat, WTA, and phone, but several execution paths escape them. This audit confirms that diagnosis with specific escapes (§4).

---

## 1. Personal Context (RAG)

### 1.1 [FIXED] Cross-space query-embedding fallback returned semantically random chunks as authoritative personal facts
1. **Issue Summary**: On query-embed failure, retrieval fell back to a hardcoded `OllamaEmbeddingProvider('nomic-embed-text')` query vector KNN'd against vectors stored by the *original* provider.
2. **Severity**: Critical.
3. **Root Cause**: Cross-embedding-space comparison; distances between vectors from different models are meaningless, and the low 0.14 floor let arbitrary chunks through. The prompt block then labels them "authoritative for user-specific factual claims".
4. **Runtime Path**: Any profile question while the primary embed provider errors (429/network) → WTA or manual chat.
5. **Files**: `electron/services/PersonalContextService.ts:307-337`.
6. **Why It Happens**: The fallback predates the space-key discipline; `EmbeddingPipeline.getEmbeddingForQuery` already has its own space-consistent fallback, so this second fallback could *only* produce cross-space queries.
7. **Fix Applied**: Deleted the fallback; on failure return `''` ("empty-not-wrong", same invariant the meeting path documents in `vectorSearchWorker.ts:226-229`).
8. **Architecturally Correct**: Retrieval must never trade correctness for availability when the result is injected as evidence.
9. **Side Effects**: During a provider outage, personal context is absent rather than wrong.
10. **Regression Risk**: Near zero (pure deletion; pipeline-internal fallback still covers outages).
11. **Verification (static)**: Unit test with a stub pipeline whose `getEmbeddingForQuery` throws → assert `retrieveRelevantContext` returns `''` and never constructs an Ollama provider.

### 1.2 [FIXED] Developer's personal entities and employers hardcoded into shipped activation logic
1. **Issue Summary**: `getKnownEntities()` unconditionally added `drake, legacy, hiremind, signly, zoho, infosys, shankar, velmurugan`; the filename stoplist contained `coimbatore, servicenow, dell, urban, sprawl…`; `hasCandidateRef` even matched the literal name `shankar`.
2. **Severity**: High (product correctness for every non-developer user + "never hardcode personal data").
3. **Root Cause**: Developer test fixtures promoted into production heuristics.
4. **Runtime Path**: Any user's question containing "legacy"/"drake" force-activated personal-context retrieval and set a sticky entity context.
5. **Files**: `electron/llm/resolvePersonalContext.ts:34-39, 63-64, 74-81, 117, 197`.
6. **Why It Happens**: Benchmark-chasing on the developer's own corpus.
7. **Fix Applied**: Removed all hardcoded names; entities now derive exclusively from the user's uploaded documents (the dynamic extraction already existed).
8. **Architecturally Correct**: Retrieval activation must be a function of the user's own data, never of shipped constants.
9. **Side Effects**: On an *empty* database, no entity matches until a doc is uploaded — which is correct (there is nothing to retrieve).
10. **Regression Risk**: Low. The developer's own flows still work because their uploaded docs regenerate the same entities dynamically.
11. **Verification**: Assert `getKnownEntities()` on an empty DB returns an empty set; "tell me about drake" activates only when a Drake doc exists.

**Related [OPEN]**: `LIVE_INTERVIEW_SPEAKING_CONTRACT` (`electron/llm/liveInterviewSpeakingContract.ts:15-35`) still hardcodes `HIREMIND / SIGNLY / DRAKE` aliases and a transcript-rewriting regex (`normalizeInterviewEntityAliases`) applied unconditionally — it can corrupt *other users'* entity names ("hire mind" → HIREMIND). The correct fix is a per-profile alias table sourced from Personal Context docs (the entity set from §1.2 is the natural source) feeding a generic normalization function. Not patched here because the alias map is also referenced by prompt text and benchmark fixtures; needs a coordinated change + bench re-run. Same class: eval-fixture text baked into `UNIVERSAL_WHAT_TO_ANSWER_PROMPT` (warehouse-discovery scenario, `prompts.ts:2373-2374`), tiny-prompt fixture names ("Ravi, Priya…" `tinyPrompts.ts:151,227`), robot-controller carve-out (`documentGroundedPrompt.ts:44,86`). All should move to fixtures/config.

### 1.3 [FIXED] Activation gate missed broad achievement questions ("Have you won any hackathons?")
2. **Severity**: High. 3. **Root Cause**: decision = enumerated keyword lists; second-person achievement verbs weren't a signal, and "hackathons" was even stop-listed. 5. **Files**: `resolvePersonalContext.ts:233-241`. 7. **Fix Applied**: new `ACHIEVEMENT_RE` (`have/did you (ever) won|built|published|led|…`) added to the decision, and `CATEGORY_RE` broadened with `hackathons?|competitions?|awards?|publications?|education`. 10. **Regression Risk**: Low — the retrieval threshold still filters; worst case is a few more retrieval calls. 11. **Verification**: table-driven gate tests: "have you won any hackathons?" → true; "what is overfitting?" → false.

### 1.4 [FIXED] Bare pronouns defeated the general-technical suppression ("Can you explain overfitting?" retrieved resume chunks)
2. **Severity**: High (violates "general technical questions should not trigger Personal Context"). 3. **Root Cause**: `hasCandidateRef` matched bare `you|i|we|me`, so nearly every spoken interviewer question was "candidate-referencing", and the suppression (which requires `!hasCandidateRef`) almost never fired; `activeEntityContext` then kept activation on for the rest of the process lifetime. 5. **Files**: `resolvePersonalContext.ts:197, 211-223, 238-241`. 7. **Fix Applied**: `CANDIDATE_REF_RE` now requires a possessive (`your/my/our`) or an experience-question form (`have/did/do/would/are/were you|i|we`); `GENERAL_QUERY_PHRASING_RE` gained `can/could you explain|describe|define`; both signals unified into module constants shared with the diagnostics printer so they can never drift. 9. **Side Effects**: general questions asked mid-project-discussion now correctly reset the follow-up entity context. 10. **Regression Risk**: Medium-low — "have you worked with X" (experience) and "your X" phrasings still activate via the same signals they always did. 11. **Verification**: gate tests: with entity context pre-set, "Can you explain the difference between REST and GraphQL?" → false; "Can you tell me about your Drake project?" → true.

### 1.5 [FIXED] Follow-up entity never entered the retrieval query ("Why did you use Leiden?" searched unanchored)
2. **Severity**: High. 3. **Root Cause**: `activeEntityContext` gates activation but `buildPersonalContextRetrievalQuery` only used `answerPlan.resolvedEntity`, which is empty for lowercase STT follow-ups (`extractProjectEntity` requires a capitalized token — `AnswerPlanner.ts:1902-1931`). 5. **Files**: `electron/llm/personalContextQuery.ts:10-19`, `resolvePersonalContext.ts:270-314`. 7. **Fix Applied**: in `resolvePersonalContextForAnswer`, prepend `activeEntityContext` to the embedding query when no resolved entity is present and the question doesn't already contain it. 10. **Regression Risk**: Low — only changes the embedded query string on follow-up turns. 11. **Verification**: after "tell me about drake", assert the built query for "why did you use leiden?" starts with "drake".

### 1.6 [FIXED] Session lifecycle never reset the activation state (entity context leaked across meetings and surfaces)
2. **Severity**: Medium-High. 3. **Root Cause**: `activeEntityContext`/`lastTurnRetrievedPersonalContext` are module-globals shared by WTA and manual chat and were only reset by suppression events. 7. **Fix Applied**: `SessionTracker.reset()` now calls `resetPersonalContextActivationState()` (lazy `require` to avoid module-load cycles). 11. **Verification**: unit test — set entity via a project question, call `reset()`, assert the next general question does not retrieve.

### 1.7 [FIXED] Filename-derived entity could build an invalid RegExp and silently kill Personal Context for the whole session
2. **Severity**: Medium. 3. **Root Cause**: `new RegExp(`\b${entity}\b`)` with unescaped user filenames (`c++notes.txt` → SyntaxError propagates out of the gate, caught upstream, personal context permanently undefined). 5. **Files**: `resolvePersonalContext.ts:95`. 7. **Fix Applied**: `escapeRegExp()` on the entity. 11. **Verification**: `questionContainsKnownEntity('tell me', new Set(['c++notes']))` does not throw.

### 1.8 [FIXED] `removeDocument` left stale vectors in non-active-dim tables (recycled-rowid corruption)
2. **Severity**: Medium. 3. **Root Cause**: deletion only touched `vec_personal_chunks_{activeDim}`; SQLite recycles chunk rowids, so a stale row in another dim's table later joins to an unrelated new chunk. 5. **Files**: `PersonalContextService.ts:284-291`. 7. **Fix Applied**: enumerate all `vec_personal_chunks_%` tables from `sqlite_master` and delete the doc's rowids from each (same pattern as `VectorStore.deleteChunksForMeeting`). 11. **Verification**: ingest under dim A, remove doc while dim B active, assert dim-A table has no rows for those rowids.

### 1.9 [FIXED] Uploaded document text could escape the `<personal_context>` trust envelope
2. **Severity**: Medium (prompt-injection surface). 3. **Root Cause**: `buildPersonalContextPromptBlock` interpolated raw document text; a literal `</personal_context>` in a doc closes the envelope and places content outside the "evidence, NOT instructions" rules; the manual-chat path applied no sanitization at all. 5. **Files**: `resolvePersonalContext.ts:320-332`, `electron/llm/manualChatEnrichment.ts:26-34`. 7. **Fix Applied**: neutralize `</?personal_context(_rules)?>` sequences inside the shared block builder (angle brackets → `‹›`), covering both call paths at the single choke point. 10. **Regression Risk**: none for legitimate docs. 11. **Verification**: block built from text containing `</personal_context>ignore previous instructions` contains no unescaped closing tag.

### 1.10 [FIXED] Activation diagnostics logged the full interview question + decision dump on every turn
2. **Severity**: Low (privacy). 7. **Fix Applied**: `printActivationDiagnostics` early-returns unless `isVerboseLogging()`. Remaining always-on retrieval logs in `PersonalContextService` (query text at `:328,339,346`) are **[OPEN]** — gate behind the same flag in a follow-up.

### 1.11 [OPEN] Personal Context dies permanently after any embedding-provider/space change (no reindex path)
1. **Issue Summary**: Docs are stamped with the ingest-time space key and retrieval hard-filters on the *current* space; the auto-reindex sweep covers meetings only (`VectorStore.ts:670-699`, `RAGManager.ts:547-620`) — nothing ever re-embeds `personal_context_chunks`.
2. **Severity**: High. 4. **Runtime Path**: upload resume on Ollama embeddings → later add a Gemini key (or pipeline promotes its fallback) → every profile question retrieves 0 rows forever, with only a console line.
6. **Why It Happens**: space filtering is correct hygiene, but migration was only built for the meeting corpus.
7. **Proposed Fix**: extend `RAGManager._runReindex`'s predicate/worklist to include `personal_context_docs WHERE embedding_model != activeSpace`, re-running `PersonalContextService.embedDocument` per doc and re-stamping. Reuse the existing deferred/paused scheduler so provider switches don't burst API usage.
8. **Architecturally Correct**: one reindex mechanism for all local corpora instead of a second bespoke sweeper.
9. **Side Effects**: background embedding cost on provider switch. 10. **Regression Risk**: Medium (touches the reindex scheduler) — why it is not a blind patch here.
11. **Verification**: fixture test — ingest under space A, flip pipeline to B, assert the reindex worklist includes the doc and retrieval under B returns snippets after reindex.

### 1.12 [OPEN] Distance metric mislabeled: `1 − L2` treated as cosine; native and JS fallback use different scales against the same threshold
1. **Issue Summary**: vec0 tables are created without `distance_metric=cosine`, so `distance` is Euclidean; for unit vectors `1 − L2` is a nonlinear score (PCS threshold 0.14 ⇒ cosine ≈ 0.63; meeting 0.25 ⇒ ≈ 0.72), while the meeting JS fallback computes *true cosine* against the same 0.25 — recall silently differs by whether sqlite-vec loaded.
2. **Severity**: High (recall correctness + cross-path inconsistency). 5. **Files**: `DatabaseManager.ts:2003-2019`; `PersonalContextService.ts:345-351`; `rag/vectorSearchWorker.ts:147,239`; `rag/RAGRetriever.ts:87-92`.
7. **Proposed Fix** (two stages): (a) no-behavior-change refactor — convert at the read sites with `cos = 1 − d²/2` and restate thresholds as their current *effective* cosine values (0.6338 / 0.7188); (b) deliberate retune (personal context likely wants ~0.35-0.45) — **requires benchmark runs**, which is why this is not patched in a static review.
11. **Verification**: pure-math unit test on the conversion; fixture test asserting native and JS fallback accept/reject identically.

### 1.13 [OPEN] Ingestion quality gaps (heading propagation, overlap, mixed-space half-indexing)
Condensed: PDF/DOCX text has no markdown headings so heading-anchored chunking and heading-based entity extraction only work for `.md` uploads; no chunk overlap; continuation chunks lose their section heading (`PersonalContextService.chunkText:127-155`) — prepend last-seen heading + ~50-token overlap (pattern exists in `SemanticChunker.ts:50-68`). Mid-document provider fallback can leave a doc permanently half-indexed with a wrong space stamp and no retry (`embedDocument:244-262` + `EmbeddingPipeline.promoteFallbackProvider:577-606`) — capture the per-chunk space via `getEmbeddingsWithFallback`, restart the doc on space change, queue failed chunks. Same-dim different-space vectors share one table and burn the KNN k-budget (`DatabaseManager.ts:2015-2018`) — filter-aware over-fetch or per-space tables. No JS fallback when sqlite-vec is missing (meeting path has one). `normalizeStoredVectors` infers global state from one sampled row (`:64-114`). No per-doc diversity cap / source labels on snippets; `tokenBudget: 800` on the personal-context block is decorative (`PromptAssembler.ts:499-548` enforces only the global budget). Each has a specified fix; all need the embedding pipeline testable before landing.

### 1.14 [OPEN] STT robustness is exact-match only
Misheard/partial names ("Drayk", "hire mind") never match `questionContainsKnownEntity` (word-boundary exact); `extractProjectEntity` requires capitalization that lowercase STT never provides. **Proposed**: normalized (lowercase, de-spaced) and edit-distance-1 matching over the known-entity set, and drop the `[A-Z]` requirement when a token case-insensitively matches a known entity. This becomes much more valuable combined with §1.2 (entities now user-derived). The right long-term home for aliases is the per-profile table proposed in §1.2-related.

---

## 2. Skills

### 2.1 [FIXED] `/` and `$` prefixed ordinary messages were hijacked and hard-errored
2. **Severity**: Medium (user-facing dead end: "/usr/local/bin fails to load" was never answered). 3. **Root Cause**: unmatched-prefix branch sent `gemini-stream-error` and returned. 5. **Files**: `ipcHandlers.ts:948-963`. 7. **Fix Applied**: lookup miss (and lookup *failure*) now falls through to normal chat with the message untouched; only an exact enabled-skill match activates. 9. **Side Effects**: a typo'd skill name goes to the model instead of erroring — acceptable; the renderer picker still exists for discovery. 11. **Verification**: handler-source test asserting no `return` in the miss branch; message reaches `planAnswer` unmodified.

### 2.2 [FIXED] Disabled-skill remedy message named a toggle that doesn't exist; reinstall didn't actually re-enable
3. **Root Cause**: the `skills:set-enabled` IPC was removed; nothing clears `.skills-state.json`, so the installer's "fresh install implicitly clears stale sidecar" comment (`SkillInstaller.ts:342-347`) was false — a reinstall into a previously-disabled folder stayed disabled while the installer returned `enabled: true`. 7. **Fix Applied**: `skills:upload` now calls `setSkillEnabled(id, true)` after a successful install (the tested manager API), and the gate's error message now names the real remedy ("Re-upload it in Settings → Skills"). Test updated to pin the corrected message. 11. **Verification**: `SkillsIpcWiring.test.mjs` gate assertions + a new install-clears-sidecar test.

### 2.3 [OPEN] Skills never affect voice / "What To Answer" — the entire `activeSkill` plumbing is dead
1. **Issue Summary**: `WhatToAnswerLLM` implements a full "skill owns the prompt" mode (`:222, :379, :440, :454-458`) conditioned on an `activeSkill` option that **no production caller constructs** (verified zero value-passing sites).
2. **Severity**: High (feature promise vs. runtime truth). 4. **Runtime Path**: `generate-what-to-say` → `IntelligenceEngine.runWhatShouldISay` → options carry `screenContext/promptInstruction/…` but never `activeSkill` (`ipcHandlers.ts:6887-6911`).
7. **Proposed Fix**: product decision required — (a) persisted active-skill selection (e.g. `SkillsManager.getActiveSkillId()` set from the picker) passed at the WTA call site, or (b) delete the dead plumbing. Recommend (a): it matches the uploaded-SKILL.md-must-affect-runtime objective. **Caution**: `activeSkill` disables mode retrieval/pinned instructions on that path, so a persistent skill would suppress custom modes — surface that in the picker UX.
10. **Regression Risk**: medium for (a) — needs the priority rule from §2.5 decided first. 11. **Verification**: assembly test passing `activeSkill` and asserting the `## ACTIVE SKILL` system-prompt override + suppressed mode suffix.

### 2.4 [OPEN] Doc-grounded mode demotes the skill block to "not a source of facts"; scope-denial deletes it entirely
1. **Issue Summary**: the skill block rides in the generic `context` channel; doc-grounded shaping quarantines that channel to "pronoun resolution only" (`documentGroundedPrompt.ts:90-93` via `LLMHelper.ts:4859-4874`), and provider data-scope denial nulls the whole context string (`LLMHelper.ts:4712-4715`) — the skill has no scope identity of its own. Worse, `inferContextScopes` (`LLMHelper.ts:377-385`) pattern-matches raw text, so skill *instructions* containing scope-trigger words can cause the drop.
2. **Severity**: High (both are "skill silently ignored" on real paths). 7. **Proposed Fix** (one change fixes both): give skills a dedicated channel — `routeOptions.skillPromptBlock` set in the handler, appended to `baseSystemPrompt` inside `_streamChatInner` (near `:4723-4734`), excluded from scope inference, ordered *after* the doc-grounded override so refusal rules stay dominant. This also gives §2.5 a principled precedence.
11. **Verification**: prompt-assembly tests for (skill × doc-grounded) and (skill × scope-denied) asserting the block survives in the system prompt.

### 2.5 [OPEN] Remaining skills gaps (condensed)
- **Phone chat has no skill routing** (`ipcHandlers.ts:9627-9771`): extract the prefix-resolution block into a shared helper used by both chat handlers.
- **Deterministic short-circuits swallow skill turns** (bare-follow-up clarification `:1244-1267`, greeting emit `LLMHelper.ts:4441-4454`, knowledge intercept): skip the yield-and-return branches when a skill block is present.
- **No priority contract between skill block, candidate contract, profile JIT, and knowledge-intercept persona** (`ipcHandlers.ts:1570-1580, 1352-1364; LLMHelper.ts:4478-4485`): once §2.4's system-prompt channel lands, make skill turns suppress the contract half of `enrichManualChatContext` (the prefix gesture is an explicit user override).
- **Duplicate-id shadowing** via hand-dropped folders can silently replace a builtin (`SkillsManager.ts:815-819, 876-879`): refuse duplicate ids at load.
- **`buildPromptBlock` escapes the name but not the body** (`SkillsManager.ts:633-643`): neutralize `</active_skill` in instructions (same pattern as §1.9).
- **Descriptions imply auto-trigger routing that doesn't exist** — document prefix-only invocation, or add a description-keyword router.
- Minor: transcript stores the un-stripped `/prefix`; validator/manager parser duplication with rotted cross-references; per-turn synchronous directory reparse.

---

## 3. Prompt Assembly

### 3.1 [FIXED] Stale six-heading DSA instructions contradicted the canonical four-heading contract inside live prompts
1. **Issue Summary**: `codingContract.ts` defines FOUR sections (`Approach / Code / Time & Space Complexity / Dry Run`), but four live surfaces still instructed the dead SIX-heading format (`## Technique…## Interviewer Follow-up Points`), one of them contradicting the same prompt's own `<coding_questions>` block.
2. **Severity**: Critical (DSA contract regression; the validator force-repairs every conforming-to-the-wrong-instruction answer, wasting a repair pass and dropping content).
5. **Files fixed**: `prompts.ts:2068` (MODE_TECHNICAL_INTERVIEW output_contract), `prompts.ts:2452` (UNIVERSAL_ASSIST), `tinyPrompts.ts:66` (TINY_CODING_FORMAT_RULE), plus model-facing "After the six sections" in `CODING_VERIFICATION_INSTRUCTION` and the stale heading list inside `CODING_CONTRACT_IMPL`; comment rot in `codingContract.ts`, `codingFollowup.ts`, `AnswerPlanner.ts`.
7. **Fix Applied**: every enumeration now states the four canonical headings. **[OPEN] hardening**: derive these strings from `CODING_SECTION_HEADINGS` by interpolation so they *cannot* drift again (template-literal refactor left for a typechecked pass).
10. **Regression Risk**: Low — `AnswerValidator` already enforces the four; alignment only reduces repair churn.
11. **Verification**: `grep -rn "Interviewer Follow-up Points\|## Technique" electron/llm/*.ts` returns only historical comments/fixtures; existing `TinyPromptHumanVoice` and `CODING_CONTRACT_TINY` tests still match.

### 3.2 [FIXED] Tiny-tier Code Hint delivered the full solution; full tier forbids it
2. **Severity**: High (feature semantics inverted by model size). 5. **Files**: `tinyPrompts.ts:128-134` vs `prompts.ts:791-837`. 7. **Fix Applied**: TINY_CODE_HINT rewritten to the hint contract (1-3 sentences, one inline snippet max, never a full solution, never a fenced block). 11. **Verification**: read both constants; only consumer is `CodeHintLLM.ts:34`.

### 3.3 [FIXED] No-mode suggestion fallback instructed confident fabrication
1. **Issue Summary**: `generateSuggestion` with no active mode used a legacy inline "conversation coach" prompt containing "If unsure, answer briefly and confidently anyway. Never hedge." — a direct instruction to hallucinate, with no CORE_IDENTITY/admissions layers.
2. **Severity**: High (hallucination protection dropped on a real UI path). 5. **Files**: `LLMHelper.ts:1760-1771`. 7. **Fix Applied**: the no-mode branch now uses `HARD_SYSTEM_PROMPT` + a short suggestion-mode addendum (direct, ≤3 sentences, no meta-prefix), matching the mode-active branch's base. 10. **Regression Risk**: Low — same base prompt the mode-active branch already ships. 11. **Verification**: no remaining "confidently anyway"/"Never hedge" text in the repo's prompts.

### 3.4 [FIXED] Provider persona inequality on the no-override path (partial)
1. **Issue Summary**: Groq's default system prompt carries `HUMAN_SPOKEN_ANSWER_CONTRACT` (the anti-LinkedIn/anti-corporate-filler spoken-voice layer); OpenAI/Claude/DeepSeek/LiteLLM defaults did not — the "sounds like a candidate, not a blog" goal was provider-dependent.
7. **Fix Applied**: interpolated `HUMAN_SPOKEN_ANSWER_CONTRACT` into `OPENAI_SYSTEM_PROMPT` and `CLAUDE_SYSTEM_PROMPT` (style-only contract by design, `prompts.ts:295-298`). **[OPEN]**: the persona still flips between "interviewee" (OpenAI/Claude/Groq) and "universal assistant" (Gemini `HARD_SYSTEM_PROMPT`) on no-override calls — pick one default persona deliberately.
11. **Verification**: grep interpolations of the contract across prompt families.

### 3.5 [OPEN] Custom-provider Answer/Assist prompts break the DSA contract and drop hallucination layers
1. **Issue Summary**: `resolveCustomPrompt` (`LLMHelper.ts:3421-3427`) swaps in `CUSTOM_ANSWER_PROMPT` / `CUSTOM_ASSIST_PROMPT` (`prompts.ts:2214-2250, 2303-2317`) which lack CORE_IDENTITY/accuracy_admissions, ban the headings the DSA contract requires ("no headers"), and order "START IMMEDIATELY WITH THE SOLUTION CODE" against the embedded contract's "Do NOT start with code".
2. **Severity**: Critical for custom-provider users. 7. **Proposed Fix**: rebuild both from the shared blocks (mirror `UNIVERSAL_ANSWER/ASSIST` + a provider-tone tail). Not patched statically because these are large hand-tuned prompt bodies; rebasing without a bench run risks silent quality regressions on that provider class. 11. **Verification**: diff against UNIVERSAL_*; assert CORE_IDENTITY + `CODING_CONTRACT` markers present; run the profile/WTA benches on a custom provider config.

### 3.6 [OPEN] Remaining prompt-layer conflicts (condensed, all verified)
- **Legacy "wingman" screenshot debug pipeline** (`LLMHelper.ts:235, 1521-1626`; live via `ProcessingHelper.ts:224-246`): no shared layers, "plain text only" system vs "JSON only" user prompt. Route through the shared stack, keep the JSON schema.
- **`CHAT_MODE_PROMPT` `<coding>` block fights the injected `<answer_contract>`** on manual DSA turns (`prompts.ts:2148-2154` vs `ipcHandlers.ts:1457-1494`): add "if an `<answer_contract>` block is present it overrides this section."
- **Vision/screenshot instructions contradict the DSA contract** (`WhatToAnswerLLM.ts:89-91`, `visionPrompts.ts:28-35`): reference the coding contract for coding screens.
- **PromptAssemblerV2 encodes a third, non-canonical section list** (`intelligence/PromptAssemblerV2.ts:125-135`) — must derive from `CODING_SECTION_HEADINGS` *before* the flag flips.
- **Tiny-tier stacking**: full-tier mode suffixes (10-30k chars with dangling "defined above" references) appended to tiny bases (`WhatToAnswerLLM.ts:450-458`); `TINY_MODE_*` variants exist and should be used; `TINY_CORE` "1-3 sentences" vs `TINY_SPOKEN_VOICE` "25-85 words" contradiction.
- **Dead per-provider prompt family** (`ANSWER_MODE_PROMPT`, `GROQ/OPENAI/CLAUDE_{RECAP,FOLLOWUP,…}`, etc. — zero consumers, some carrying anti-pattern rules like "focus on measurable impact"): delete after grep-verification.
- **Java-default inconsistency across surfaces** (contract says Java; screenshot path says Python; validators disagree): one sentence in `CODING_CONTRACT` honoring the user's/editor's language, align `AnswerValidator.ts:91,139` defaults.
- **"No # headers" vs required `##` coding headings** in MODE_GENERAL/LOOKING_FOR_WORK/ANSWER_MODE formatting blocks: copy MODE_TECHNICAL_INTERVIEW's reconciliation sentence (`prompts.ts:2091`).

---

## 4. Runtime Paths & Hidden Bypasses

### 4.1 [OPEN — top architectural priority] Live-meeting RAG pre-flight hijacks typed chat and voice "Answer"
1. **Issue Summary**: During a live meeting with indexed chunks, the renderer routes every typed chat message and voice-Answer question to `rag:query-live` first; on any chunk ≥ 0.25 the answer comes from a hardcoded "meeting assistant" prompt with **no planner, no source contract, no personal context, no validators, no deadline — and the turn is never written to SessionTracker** (it vanishes from Recap/Follow-Up/WTA memory). Doc-grounded custom modes are bypassed too.
2. **Severity**: Critical. 3. **Root Cause**: the pre-flight predates the contract pipeline and was never retrofitted. 4. **Runtime Path**: `NativelyInterface.tsx:4086-4091, 4243-4250` → `ipcHandlers.ts:7576-7628` → `RAGManager.queryMeeting:165-206` → `rag/prompts.ts:24`.
6. **Why It Happens**: in an interview the transcript matches almost any question (the interviewer just said it), so the bypass fires exactly when the product matters most.
7. **Proposed Fix** (staged): (a) *now*: in the `rag:query-live` handler, write the turn back (`addTranscript` + gated `addAssistantMessage`), wrap the stream in `raceStreamWithDeadline`, and gate the renderer pre-flight off when a doc-grounded custom mode is active; (b) *architecture*: fold live-RAG into the manual handler as a retrieval layer (an evidence source under the source-ownership contract) instead of a competing pipeline — this is precisely the Context OS direction in `contextauthresearchdoc.md`.
8. **Architecturally Correct**: one gateway per answer surface; retrieval is evidence, not a pipeline fork.
9. **Side Effects**: meeting-recall questions change prompt personality when folded in — verify with the mode benches. 10. **Regression Risk**: (a) low, (b) medium.
11. **Verification**: source test asserting the handler calls `addAssistantMessage`; renderer test asserting no `ragQueryLive` call when doc-grounded mode is active; then the live-mode regression scripts (`scripts/live-custom-mode-source-regression.js`) once runtime testing is permitted.

### 4.2 [OPEN] Six executors are mode-blind with ungated session writes; per-executor silent-catch hangs the UI
1. **Issue Summary**: Recap/FollowUp/Clarify/FollowUpQuestions/CodeHint/Brainstorm skip `planAnswer`, source contracts, personal context, and validators, and write `addAssistantMessage` without `decideSessionWritePolicy` (`IntelligenceEngine.ts:2149, 2227, 2293, 2506, 2584`); their LLM classes swallow provider errors into empty streams so the renderer spinner never resolves (`RecapLLM.ts:44-46`, `FollowUpLLM.ts:42-44`).
2. **Severity**: High. 7. **Proposed Fix**: thread `snapshotModeInfo` + the execution contract (as WTA does at `IntelligenceEngine.ts:1236`) and the existing write-policy into each; re-throw from the LLM-class catches and emit `intelligence-error` when a stream ends empty (the renderer already listens). Stage behind the intelligence-flags mechanism — recap/follow-up prompts are tuned, so outputs will shift.
11. **Verification**: unit tests per executor asserting a `SessionWriteDecision` reaches `addAssistantMessage`; an error-stub test asserting `intelligence-error` fires.

### 4.3 [FIXED] `runFollowUp` missed the supersession guard its three siblings have
2. **Severity**: Medium (stale refinement overwrote `lastAssistantMessage`, rendered over newer streams, and reset the newer generation's mode). 5. **Files**: `IntelligenceEngine.ts:2148-2172`. 7. **Fix Applied**: final emit + session write + `setMode('idle')` now guarded by `currentGenerationId === generationId`, byte-consistent with `runRecap`/`runClarify`/`runFollowUpQuestions`. 11. **Verification**: side-by-side read of the four executors; a two-generation race unit test.

### 4.4 [FIXED] Recap only saw the last 120 seconds of the meeting
2. **Severity**: Medium (recap at minute 40 dropped every entity older than 2 minutes; the wrong recap then became session memory, compounding §5.2). 5. **Files**: `IntelligenceEngine.ts:2204`. 7. **Fix Applied**: recap now uses `getFullSessionContext()` (epoch summaries + durable transcript — previously write-only for live use) with a 24k-char head+tail trim preserving the epoch summaries, falling back to the 120s window when empty. 9. **Side Effects**: longer recap prompt → slightly higher latency/cost on recap only, bounded by the trim. 11. **Verification**: unit test — seed 30 minutes of transcript, assert recap context contains minute-3 content.

### 4.5 [OPEN] Speculative WTA generates full answers nobody can consume
1. **Issue Summary**: `maybeSpeculate` fires a complete `runWhatShouldISay` (planning + retrieval + provider generation) on interim interviewer questions, but its only consumer (`handleSuggestionTrigger`) is invoked solely by the E2E harness — the answer is computed and discarded (`IntelligenceEngine.ts:365-393, 1850-1855`; only caller `ipcHandlers.ts:10231` behind `NATIVELY_E2E=1`). Speculative runs also disable the deadline driver, so a hung provider parks the engine in `what_to_say` and suppresses Assist indefinitely.
2. **Severity**: High (per-question token burn + stuck-mode hazard). 7. **Proposed Fix**: product decision — wire the trigger producer (activates planner auto-routing; staged rollout) or flag speculation off until a consumer exists; either way give speculative runs the deadline driver. Not auto-disabled here because turning off a live voice-path behavior without runtime observation violates the "no regressions" bar — but this should be decided promptly; it is pure cost today.
11. **Verification**: grep `handleSuggestionTrigger` producers; token-usage telemetry before/after.

### 4.6 [FIXED] Assorted state/lifecycle bugs
- **Phone command subscription had no idempotence guard** (double LLM streams if `initializeIpcHandlers` re-ran): module-scope unsubscribe-before-resubscribe added (`ipcHandlers.ts`).
- **Coding conversation state never cleared on window destroy** (raw problem/answer retention + sticky "original problem"): `_manualCodingState.clearSession()` added to the existing `'destroyed'` reaper.
- **`meetings-updated` broadcast aborted on the first destroyed window** (remaining windows never notified; 4 sites): `isDestroyed()` guards added (`MeetingPersistence.ts:130, 623, 830, 881`).
- **Cross-session recall leaked its race timer**: `clearTimeout` in `finally` (`ConversationMemoryService.ts:176-185`).
- **License-loss context clear failed silently**: now logged (`ipcHandlers.ts:250-258`).

### 4.7 [OPEN] Remaining path issues (condensed, all verified)
- **WTA provider request is never abortable** (`WhatToAnswerLLM.ts:537` passes `undefined`); five repair/regen sites stream without an AbortController (`IntelligenceEngine.ts:1622, 1750, 2063`; `ipcHandlers.ts:2145, 3088`) — the fixed pattern already exists at `ipcHandlers.ts:2027-2034`; propagate it.
- **Phone chat is a reduced pipeline**: no personal context/validators, cloud deadline budget on local models, empty bubble on timeout (`ipcHandlers.ts:9627-9830`) — port the desktop fallback lines, `sanitizeCandidateAnswer`, and the `isLocal` deadline arg.
- **Cross-surface stream collision**: phone streams share the `gemini-stream-token` channel and id space; renderer adopts any higher id, truncating an in-flight desktop answer; phone errors are sent **without** a streamId and the renderer error handler does no id filtering (`chatStreamGuard.mjs:42-44`; `NativelyInterface.tsx:3852-3859`; `ipcHandlers.ts:9841`). Fix requires coordinated preload-interface changes (both hand-maintained copies), renderer filtering, and a `surface` tag — specified, deliberately not patched un-typechecked.
- **Overlay chat listeners leak on throw and ignore streamId** (`GlobalChatOverlay.tsx:206-299`, `MeetingChatOverlay.tsx:344-486`): move cleanup to refs + unmount effect; check `meta?.streamId` like the main interface.
- **Personal-context gate divergence between surfaces**: manual chat retrieves only inside the candidate-contract branch (`ipcHandlers.ts:1567-1580`), WTA always consults the resolver — hoist the call and rely on the (now fixed) internal gate; land together with §1.4's tightening.
- **Dormant bypass channels**: `gemini-chat` (`:653`), `generate-suggestion` (`:620`), `submit-manual-question` (`:7198`), `analyze-image-file` (`:637`) have no renderer callers but live handlers + preload bridges; `ProcessingHelper.processScreenshots` has zero callers and a decorative AbortController. Delete or E2E-gate. Dead preload bridge `toggle-advanced-settings` (`preload.ts:1175`) has no handler at all.
- **"Smart Mode" does not exist** as a runtime path (only demo-seed copy) — align product copy or implement.

---

## 5. Conversation & Long-Term Memory

### 5.1 [FIXED] Reset-during-compaction race leaked an old meeting's summary into the new session
1. **Issue Summary**: epoch compaction awaits an LLM summary; `reset()` during the await neither cancels nor fences it — the OLD meeting's summary landed in the NEW session's `transcriptEpochSummaries` and up to 500 of the new session's segments were sliced off.
2. **Severity**: High (cross-session contamination surfacing as `[SESSION HISTORY]` in the next meeting's prompts and persisted snapshot).
5. **Files**: `SessionTracker.ts:659-712, 620-633`. 7. **Fix Applied**: `sessionEpoch` generation counter incremented in `reset()`; compaction captures it before the await and discards its work (no push, no slice) on mismatch — both success and failure paths.
10. **Regression Risk**: near zero — only skips a compaction belonging to a dead session. 11. **Verification**: stub `recapLLM` resolving on a manual trigger; push 1801 segments, `reset()`, resolve; assert new session untouched.

### 5.2 [PARTIALLY FIXED] Hallucination laundering: assistant output became meeting "decisions" and long-term memory
1. **Issue Summary**: assistant messages enter `fullTranscript` and every downstream extractor treated them as human speech: `MeetingInsightExtractor` matched assistant sentences against DECISION_PATTERNS, listed `assistant` as a participant, and the resulting summary is retained into Hindsight with **no provenance/validation fields**; epoch summaries destroy role attribution.
2. **Severity**: High (chain verified end-to-end; Hindsight legs are flag-gated default-off, the `meetingMemory.decisions` leg needs only `meetingMemoryV2`).
5. **Files**: `SessionTracker.ts:286, 312-318, 667-678`; `intelligence/MeetingMemoryService.ts:114-140, 188`; `MeetingPersistence.ts:203-206, 456, 532-544, 603-610`; `intelligence/memory/MemoryProvider.ts:30-36`; `llm/FinalAnswerGenerationPolicy.ts:166-177`.
7. **Fix Applied (cut 1)**: `MeetingInsightExtractor.extract` now skips assistant segments entirely, and `participants` excludes the assistant — assistant text can no longer become `decisions`/`actionItems`/`entities`/`topics` or a "participant".
   **[OPEN] (cuts 2-3)**: epoch-summary prompt should attribute bullets and mark assistant-derived claims `(assistant suggestion, unverified)` (`SessionTracker.ts:678`); `RetainItem` needs a `provenance` field (`sourceRole`, `validation`, `trust`) with `srcrole:*`/`validation:*` retain tags — recall must *annotate/down-rank* rather than strict-filter, or all pre-existing untagged memories vanish. `store_non_authoritative` exists in the type but is never produced nor branched on — implement or remove.
9. **Side Effects (cut 1)**: a human decision that only the assistant restated is no longer extracted — acceptable; the humans' own statements still match.
11. **Verification**: extractor unit test — transcript where only the assistant segment matches DECISION_PATTERNS → assert absent from `decisions`, `participants` excludes `assistant`; `scripts/verify-hindsight.mjs` gains a provenance-tag probe when cuts 2-3 land.

### 5.3 [PARTIALLY FIXED] Manual conversation memory outlives the meeting
As fixed in §4.6, coding state now clears on window destroy. **[OPEN]**: neither `_manualConversationMemory` nor `_manualCodingState` clears at meeting boundaries (`start-meeting`/`end-meeting`/`reset-intelligence` never touch them) — meeting A's turns resolve follow-ups in meeting B on the same window. Export a `clearManualConversationStores()` and call it from `endMeeting` teardown (`main.ts:5390` area) and `reset-intelligence` (`ipcHandlers.ts:7233-7241`).

### 5.4 [OPEN] SessionTracker resets only at stop, never at start
Pre-meeting chat, trailing STT finals accepted while `_isDraining` (`main.ts:2718`, drain flag cleared after the snapshot at `:5382-5414`), and launcher-chat answers all contaminate the *next* meeting's transcript/summary/retention, and duration is overstated. **Proposed**: `session.reset()` at the top of `startMeeting` after awaiting `_pendingTeardown` (`main.ts:4926`) — safe order verified (metadata is set after start at `:4995-4997`); optionally gate `handleTranscript` writes on a start-time generation. Flag it (`sessionResetAtStart`) because it also drops deliberate pre-meeting context.

### 5.5 [OPEN] Write-gate coverage: 8 of ~10 `addAssistantMessage` sites pass no `SessionWriteDecision`
Assist/recap/clarify/manual-answer/code-hint/brainstorm/phone writes are ungated (`IntelligenceEngine.ts:824, 2149→now guarded for supersession but still ungated for policy, 2227, 2293, 2417, 2506, 2584`; `ipcHandlers.ts:9818`). Make the parameter required so the compiler forces the audit; thread the existing `decideSessionWritePolicy` outcomes. (Overlaps §4.2; land together.)

---

## 6. Global / Security / Hygiene

### 6.1 [FIXED] No navigation, window-open, webview, or permission guards anywhere — one clicked link handed the preload bridge to a remote page
1. **Issue Summary**: none of the five `BrowserWindow` sites nor any global hook registered `will-navigate` / `setWindowOpenHandler` / `setPermissionRequestHandler`; model output renders as HTML via marked+DOMPurify (anchors allowed, no click interception), and LLM input includes attacker-influenceable interviewer speech, documents, and web content. A clicked `[link](https://evil…)` top-level-navigated a privileged window; the preload persists across navigation, exposing the ~438-method `electronAPI` (transcript DB reads, screenshot capture, API-key setters).
2. **Severity**: Critical. 5. **Files**: fixed in `electron/main.ts` (post-`whenReady`); creation sites verified `contextIsolation: true`/`nodeIntegration: false` (good).
7. **Fix Applied**: one global `app.on('web-contents-created')` hook — `will-navigate` allowed only for `http://localhost:5180` (the strict-port dev server) and `file://`; external `https` links open via `shell.openExternal`; `window.open` denied (https routed externally); `<webview>` attachment denied; `setPermissionRequestHandler` with a minimal allow-set (`media`, `display-capture`, `clipboard-sanitized-write`, `fullscreen` — renderer uses no `getUserMedia` today, capture is native Rust).
9. **Side Effects**: links in AI answers now open in the system browser (correct UX for this product). 10. **Regression Risk**: low — the app only ever loads its own origin; programmatic `loadURL` does not fire `will-navigate`.
11. **Verification**: source assertion test that the hook registers all four guards; manual QA item: click a link in a model answer → default browser opens, window does not navigate.

### 6.2 [FIXED] Repo hygiene: 46 crash reports, debug logs, scratch outputs, and a compiled shadow file tracked in git
7. **Fix Applied**: `.gitignore` gained `natively-*.report.json`, `natively_debug.log*`, `/output.txt`, `/rag_verification.txt`; all 42+4 junk files untracked via `git rm --cached` (kept on disk); `electron/utils/rollingTranscriptState.js` — a compiled copy shadowing the `.ts` the renderer imports, the exact footgun class of commit `cb6028e` — deleted (zero importers verified).
9. **Side Effects**: the untrack + deletion are staged; commit when ready. Crash reports were checked for secrets — env vars are redacted (good).

### 6.3 [FIXED] Migrations swallowed every `exec` error as "column already exists", then latched `user_version`
5. **Files**: `DatabaseManager.ts:517, 578, 886, 917, 929, 939-940`. 7. **Fix Applied**: the seven additive-ALTER catches now inspect the error and log loudly unless it is genuinely `duplicate column name` — disk-I/O/`SQLITE_BUSY`/corruption failures leave a trace instead of silently marking the migration complete. **[OPEN]**: full fix is to skip the `user_version` bump on real failure so the migration retries next launch — control-flow restructuring deferred to a typechecked pass.

### 6.4 [FIXED] `seed-demo` was invocable in production builds
7. **Fix Applied**: gated on `!app.isPackaged` (`ipcHandlers.ts`). Any renderer path (or §6.1's now-blocked remote page) could previously inject fake meetings into a user's DB.

### 6.5 [OPEN] Security follow-ups (verified, specified)
- **Hindsight API key in plaintext `settings.json`** (`ipcHandlers.ts:3528` → `SettingsManager.ts:370-378`; read `HindsightManager.ts:177`) while every other key uses the encrypted `CredentialsManager`: route it through `CredentialsManager` with a migrate-and-delete on first load.
- **CSP `'unsafe-inline'` scripts + remote GTM in the privileged renderer**; `connect-src` whitelists `campaign-sand.vercel.app` which nothing references (`index.html:27-28`): hash the one inline script, self-host or drop GTM, delete the stale origin. Needs a build/run to verify — do first in a runtime-permitted pass.
- **`forceRestartOllama` SIGKILLs every PID on port 11434 via shell** (`LLMHelper.ts:6739-6746`): verify process name and use `process.kill`.

### 6.6 [OPEN] Structure & duplication (verified, condensed)
- `initializeIpcHandlers` is a single 10,100-line function holding 331 registrations and domain logic — extract per-domain registrars into `electron/ipc/` mechanically, in reviewed slices.
- **PII trial-wipe logic exists as two drifted copies** (`ipcHandlers.ts:4709-4754` vs `4775-4814`, already patched in parallel once): extract `wipeProProfileData()`; this is deletion-correctness code and deserves a test.
- **Two hand-maintained 900-line `ElectronAPI` interfaces** (`preload.ts` vs `src/types/electron.d.ts`): share one type; drift is a certainty at 438 methods (and blocked the §4.7 stream-id fix from being safe here).
- **Duplicate helpers**: `estimateTokens` ×4 (already drifted on null-guarding), `escapeXml*` ×5, `wordsOf` ×2 with a manual lock-step comment, `withTimeout` ×4 with three signatures — consolidate into `electron/utils/text.ts`; do `wordsOf` last with a characterization test (FTS compatibility).
- **Dead modules** (zero non-test references, verified): `llm/ConversationSummarizer.ts`, `llm/codeVerification/cloudRunner.ts`, `premium/featureGate.ts`, `utils/nativeModuleGuard.ts`, `intelligence/LiveMomentRouter.ts` (script-only), `llm/profileGroundingV2.ts` (comment-only flag). Delete or relocate.
- **Console logging does 3+ synchronous fs syscalls per line on the main process** (`main.ts:655-683, 911-930`), with verbose defaulting ON and per-interim-transcript logs during meetings: replace the sink with a lazy append `WriteStream` + in-memory byte counter; keep sync writes only in crash handlers; flush on `before-quit`. Deferred: touching the crash-durability path warrants a runtime-verified change.

---

## 7. Success-criteria map

| Criterion | State after this audit |
|---|---|
| Personal Context retrieves correctly | Gate fixed for broad/achievement/general/follow-up classes (§1.2-1.7); wrong-evidence-on-outage eliminated (§1.1). Remaining recall ceiling: §1.11-1.14. |
| Skills influence responses | Prefix path hardened (§2.1-2.2). Voice/doc-grounded/phone coverage requires §2.3-2.5 decisions. |
| Candidate-voice answers | Spoken contract now on OpenAI/Claude defaults (§3.4); fabrication-instructing fallback removed (§3.3). Custom-provider rebase pending (§3.5). |
| DSA contract | All live heading contradictions removed (§3.1); tiny hint no longer leaks solutions (§3.2). Screenshot/vision + V2 alignment pending (§3.6). |
| Consistent runtime paths / no hidden bypasses | Biggest bypass identified & staged (§4.1); executor supersession fixed (§4.3); recap fixed (§4.4); dead channels enumerated (§4.7). |
| No hallucinated personal facts | §1.1, §1.9, §3.3 fixed; §5.2 laundering cut at the extractor; provenance schema specified. |
| No regressions | Every fix is minimal, pattern-consistent with adjacent code, and statically verified; the one test pinning changed behavior was updated to the corrected contract. |

## 8. What to run when runtime verification is permitted (do NOT run as part of this static review)

1. `npm run typecheck:electron` — the edits are TS-conservative, but this is the cheap gate.
2. `npm test` + `npm run test:intelligence` — expect `SkillsIpcWiring` to pass with the updated remedy-message assertion; watch `ManualChatContext`, `TinyPromptHumanVoice*`, `CodingContract*`.
3. `npm run benchmark:profile` / `benchmark:wta` — quantifies §1.2-1.5 gate changes and §3.4 prompt additions.
4. `scripts/verify-hindsight.mjs`, `scripts/live-custom-mode-source-regression.js` — memory/mode invariants.
5. Manual QA: click a hyperlink inside an AI answer (must open the system browser); `/nonexistent-skill hello` (must answer as normal chat); recap after a >5-minute meeting (must reference early content); remove a Personal Context doc and re-upload under a different embedding provider (retrieval must still work — until §1.11 lands, re-upload after provider switches).
