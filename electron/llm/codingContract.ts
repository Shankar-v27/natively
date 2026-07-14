// electron/llm/codingContract.ts
//
// THE single source of truth for the coding/DSA answer structure. Every prompt
// surface and the validator import from here, so the six sections, their exact
// order, and their `## ` heading form can never drift apart again.
//
// History: the section spec was duplicated across prompts.ts (colon labels),
// tinyPrompts.ts (comma list), AnswerPlanner.ts (## headings), the assist
// prompt (### Dry Run), and AnswerValidator.ts (## headings). The model got
// contradictory instructions and the validator's `## ` check could reject the
// very format another prompt asked for. This module ends that.
//
// Dependency-free on purpose (no imports) so it can be pulled into prompts.ts,
// AnswerPlanner.ts, AnswerValidator.ts, and tests without any cycle risk.

/** The six required section titles, WITHOUT the markdown prefix. */
export const CODING_SECTIONS = [
  'Approach',
  'Code',
  'Time & Space Complexity',
  'Dry Run',
] as const;

export type CodingSection = (typeof CODING_SECTIONS)[number];

/** The six headings in their exact, validator-checked markdown form. */
export const CODING_SECTION_HEADINGS: readonly string[] = CODING_SECTIONS.map(s => `## ${s}`);

/**
 * The full contract text injected into prompts. Imperative, model-facing.
 * Keep this the ONLY place the prose lives.
 */
export const CODING_CONTRACT = `CODING / DSA RESPONSE CONTRACT — output these EXACT markdown headings, in THIS order, with nothing before the first heading:

## Approach
- Detailed, interview-style spoken reasoning representing the exact words the candidate speaks while solving the problem. Do NOT summarize the known solution. Simulate genuine, technically correct problem-solving reasoning where the candidate appears to DISCOVER the optimal solution from the limitations of simpler approaches. The reasoning must be enough for 45 to 90 seconds of natural speech before code, with every sentence contributing to understanding the problem, exploring an approach, identifying a limitation, deriving an observation, explaining the algorithm, or defending correctness. Do not add filler.
  Follow this MANDATORY REASONING FLOW (stages 1-8):
    1. STAGE 1 — UNDERSTAND THE REQUIREMENT: Briefly state what the algorithm actually needs to compute and any constraint/property that affects the solution. Do not mechanically repeat the problem statement. Use a natural candidate style (e.g., "So basically, I need to...").
    2. STAGE 2 — FIRST NATURAL APPROACH: Explain the first straightforward approach that comes to mind. Explain HOW it works before discussing complexity. Do not just name it "brute force".
    3. STAGE 3 — ANALYZE THE LIMITATION: Explain why the first approach is weak, state its complexity, and identify what work/calculation is being repeated (e.g., scanning the array again for a value). This must motivate the optimal approach.
    4. STAGE 4 — DERIVE THE KEY OBSERVATION: Derive the optimal insight from the repeated-work bottleneck. Define what you need and how to get it without listing a data structure yet.
    5. STAGE 5 — CHOOSE AND JUSTIFY THE TECHNIQUE: Introduce the data structure/algorithm and explain WHY it solves the bottleneck. Never introduce a technique without justification.
    6. STAGE 6 — WALK THROUGH THE OPTIMAL ALGORITHM VERBALLY: Explain the final algorithm in execution order, matching the code exactly.
    7. STAGE 7 — CORRECTNESS DETAIL / EDGE CASE: Mention one correctness-relevant detail when appropriate (e.g., duplicate handling, visited timing, boundaries, base cases). Do not force if none is meaningful.
    8. STAGE 8 — NATURAL CODE TRANSITION: End the Approach naturally (e.g., "So this gives me O(n) average time, and I'll implement it with a HashMap."). Do NOT say "Now let's see the code." or similar.

  PATTERN-SPECIFIC REASONING REQUIREMENTS (follow when applicable):
    - ARRAY / HASHING: Identify repeated searching/counting. Derive fast lookup need. Explain what the map/set stores.
    - TWO POINTERS: Explain property enabling pointer movement. Why moving one pointer cannot remove a valid answer.
    - SLIDING WINDOW: Explain why the answer is contiguous. Identify repeated subarray work. Explain window state and when/why the left pointer moves.
    - PREFIX SUM: Identify repeated range-sum work. Explain how range is computed from two prefix states.
    - BINARY SEARCH: Identify monotonic condition/ordered search space. Explain what mid tells us. Why half can be discarded.
    - STACK: Explain why LIFO matches the problem.
    - MONOTONIC STACK: Identify next-greater/smaller search. Explain stack invariant and why elements pop.
    - QUEUE / BFS: Explain level-by-level utility. For shortest path in unweighted graph, connect levels to edge count.
    - DFS: Define recursive state. Explain what each recursive call represents. Explain visited/cycle handling.
    - HEAP / PRIORITY QUEUE: Identify repeated min/max selection. Why sorting is too expensive. What the heap maintains.
    - GREEDY: Explain the local choice. Invariant showing local choice does not hurt the future solution.
    - BACKTRACKING: Describe decision tree. Explain choose → explore → undo. Explain pruning.
    - DYNAMIC PROGRAMMING: Start from choices/recursive interpretation. Explain overlapping subproblems and subproblem state. Define DP state in plain English (e.g., "dp[i][j] represents..."). Derive transition from choices. Explain base case. Explain why fresh DP table is needed when current element cannot be reused. If memoization to tabulation, explain relationship.
    - TREE: Clarify recursive function role per node. Combine left/right subtree results.
    - GRAPH: Define nodes/edges. Explain traversal state and cycle/visited handling.
    - TOPOLOGICAL SORT: Connect to dependency ordering. Explain indegree or DFS state. Cycle impact.
    - TRIE: Identify prefix comparison. Explain character reuse.
    - UNION FIND: Explain connectivity problem, parent representatives, path compression, and union by rank/size.

  ANTI-EDITORIAL LANGUAGE:
    - Avoid: "The optimal solution leverages...", "The intuition is straightforward...", "We employ...", "This problem can be solved using...", "The key insight is to utilize...", "Clearly...", "Obviously...", "It is evident...", "By leveraging...".
    - Prefer: "My first thought is...", "The problem with that is...", "What I'm repeatedly doing here is...", "If I look at the current element...", "That means I only need...", "So a HashMap fits here because...", "One detail I need to be careful about is...", "From here, I can...".

## Code
- Complete Java implementation in ONE fenced block with a language tag (\`\`\`java). Use standard Java. Use LeetCode-compatible class Solution when the problem appears to be LeetCode-style. Use meaningful variable names. Keep code interview-readable. Avoid unnecessary classes and abstractions. Avoid clever one-liners that reduce readability. Do not over-comment. Add short comments only for non-obvious logic. Do NOT start the answer with code — the \`## Approach\` heading comes first.

## Time & Space Complexity
- Time Complexity: O(...)
- Space Complexity: O(...)
- Add a short explanation if required.

## Dry Run
- Concise algorithm-specific dry run. Adapt the dry run to the algorithm (e.g., show meaningful DP state transitions, sliding window movement, binary search bounds).

Every heading is mandatory and must appear verbatim (with the \`## \` prefix). Even a small/local model must emit every heading. A missing/renamed heading, or starting with code, is a format failure.`;

/**
 * A compact one-line variant of the contract for tiny-model prompts where token
 * budget is tight but the SAME heading contract must hold.
 */
export const CODING_CONTRACT_TINY = `Coding/DSA answers MUST use these EXACT markdown headings, in order, nothing before the first: "## Approach", "## Code" (one fenced block with java language tag), "## Time & Space Complexity", "## Dry Run". Never start with code. A missing/renamed heading is a failure.`;

/**
 * Contract for GENERAL IMPLEMENTATION tasks (React components, scripts, utilities,
 * UI builds) that are NOT classic DSA / LeetCode / interview algorithm questions.
 * Used by `CODING_IMPL_TEMPLATE` in AnswerPlanner for `coding_question_answer`.
 *
 * Why a separate contract: the DSA six-section template (CODING_CONTRACT) forces
 * every coding answer into an interview-walkthrough shape ("## Approach / ##
 * Technique / ## Code / ## Dry Run / ## Complexity / ## Interviewer Follow-up
 * Points") with a python fence. That is wrong for "write a React stopwatch" or
 * "build me a CSV parser" — the user wants ready-to-run code, not an essay. This
 * contract keeps the no-leak / no-Natively rules but asks for code-first output
 * with the CORRECT language tag and a short explanation. The repair layer also
 * sniffs for JSX/React content and corrects a `python` fence to `tsx` defensively.
 */
export const CODING_CONTRACT_IMPL = `IMPLEMENTATION RESPONSE CONTRACT:
- Write the complete code in ONE fenced code block with the CORRECT language tag:
  - React / JSX / TSX → \`\`\`tsx
  - TypeScript (non-JSX) → \`\`\`typescript
  - JavaScript (non-JSX) → \`\`\`javascript
  - Python → \`\`\`python
  - SQL → \`\`\`sql
  (match the language the user asked for or implied)
- After the code, write a SHORT explanation (3–6 sentences) covering key design
  decisions and any non-obvious parts.
- Do NOT use the DSA interview section headings (## Approach / ## Technique /
  ## Dry Run / ## Complexity / ## Interviewer Follow-up Points) unless the user
  explicitly asks for them.
- This is a complete, ready-to-run implementation — not an interview walkthrough.`;

/**
 * Optional verification-spec instruction. Appended to the coding prompt ONLY
 * when code-execution verification is enabled. Asks the model to emit a hidden
 * machine-readable test block AFTER the six sections so Natively can run the
 * code against test cases in the background. The block is stripped before the
 * answer is shown (see stripVerificationSpec) — the user never sees it.
 *
 * `input` is the ARGUMENT LIST for the entry function (a one-arg function still
 * uses a one-element array), and `expected` is the value it should return.
 */
export const CODING_VERIFICATION_INSTRUCTION = `After the six sections, output a hidden test block EXACTLY in this form (it is removed before display, so the user never sees it — keep it strictly valid JSON):

<verification_spec>
{"entry":"<the function or method name in your Code, e.g. twoSum>","language":"<python|javascript|java|cpp|...>","cases":[{"input":[<arg1>,<arg2>],"expected":<return value>}]}
</verification_spec>

Rules for the spec:
- "entry" MUST be the exact name of the function/method a caller would invoke in your Code (for a "class Solution" method, use the method name).
- "input" is the ARGUMENT LIST passed to that function, in order (wrap a single argument in a one-element array).
- Include EVERY example from the problem statement, PLUS 1-3 edge cases (empty input, duplicates, boundaries) you are confident about.
- Use only concrete JSON values (numbers, strings, booleans, arrays, objects, null). No code, no expressions, no comments.
- LINKED LISTS / BINARY TREES: if any argument or the return value is a linked list (ListNode) or binary tree (TreeNode), add "argTypes" and/or "retType" so the runner can build/compare them. Use "list" for a linked list, "tree" for a binary tree, "value" (or omit) otherwise. Encode a linked list as a plain array [1,2,3]; encode a binary tree in LeetCode LEVEL-ORDER with null for missing nodes, e.g. [3,9,20,null,null,15,7]. Example: \`{"entry":"reverseList","language":"python","argTypes":["list"],"retType":"list","cases":[{"input":[[1,2,3]],"expected":[3,2,1]}]}\`.
- SQL: if your Code is a SQL query, set "language":"sql" and OMIT "entry"/"cases". Instead provide "schema" (array of CREATE TABLE statements), "seeds" (array of INSERT statements), and "expected" (the result-set rows as {column: value} objects using your SELECT's output column names/aliases). Add "ordered":true ONLY if the problem requires a specific row order; otherwise omit it (rows compare order-insensitively). Write standard SQL that runs on SQLite. Only a single read-only SELECT is verified. Example: \`{"language":"sql","schema":["CREATE TABLE T(id INT, v INT)"],"seeds":["INSERT INTO T VALUES (1,10),(2,20)"],"expected":[{"id":2,"v":20}]}\`. If you cannot give reliable schema/seed/expected, emit \`{"language":"sql","schema":[],"seeds":[],"expected":[]}\` to skip verification rather than guess.
- If you genuinely cannot produce reliable expected outputs, output \`<verification_spec>{"entry":"<name>","language":"<lang>","cases":[]}</verification_spec>\` rather than guessing wrong values.`;

/**
 * The regex that finds the hidden spec block (for stash-and-strip). The close
 * tag is OPTIONAL: a truncated stream (max-tokens / network cutoff / model
 * error) can emit the opening tag with no close — we must still strip from the
 * opening tag to end-of-string so the raw spec never leaks into the displayed
 * or persisted answer. `[\s\S]*?` + the `(?:</verification_spec>|$)` alternation
 * strips a terminated block minimally, or an unterminated one to EOF.
 */
export const VERIFICATION_SPEC_RE = /\s*<verification_spec>[\s\S]*?(?:<\/verification_spec>|$)/i;

/**
 * Remove EVERY hidden <verification_spec> block from an answer before display.
 * A fresh GLOBAL regex is created per call (not the exported constant) so we
 * strip ALL blocks — a model that hallucinates a second/trailing spec must not
 * leak it — without the shared-`lastIndex` footgun of a module-level /g regex.
 * Idempotent and safe on answers that never had one.
 */
export const stripVerificationSpec = (answer: string): string =>
  typeof answer === 'string'
    ? answer.replace(/\s*<verification_spec>[\s\S]*?(?:<\/verification_spec>|$)/gi, '\n').trim()
    : answer;

/**
 * Stateful, streaming-safe suppressor for the hidden <verification_spec> block.
 * The spec is always emitted AFTER the six visible sections, so once we see the
 * opening tag (even partially, across chunk boundaries) we suppress it and
 * everything after it — the spec never reaches the UI mid-stream. Used per
 * stream in the WTA + chat coding paths. A small tail buffer holds back a
 * possible partial "<verification_spec" prefix until we know it isn't the tag.
 */
export class StreamingSpecStripper {
  private suppressing = false;
  private tail = '';
  private static readonly OPEN = '<verification_spec';
  // Longest prefix of OPEN we might be mid-emitting; hold back at most this much.
  private static readonly HOLD = StreamingSpecStripper.OPEN.length;

  push(chunk: string): string {
    if (this.suppressing) return '';
    let buf = this.tail + chunk;
    const idx = buf.indexOf(StreamingSpecStripper.OPEN);
    if (idx >= 0) {
      this.suppressing = true;
      this.tail = '';
      return buf.slice(0, idx); // emit text before the spec, drop the rest
    }
    // No full tag yet. Hold back a trailing slice that could be a partial tag so
    // we don't emit "<verification_sp" and then suppress the rest next chunk.
    const keep = Math.max(0, buf.length - StreamingSpecStripper.HOLD);
    const emit = buf.slice(0, keep);
    this.tail = buf.slice(keep);
    return emit;
  }

  /** Flush any safely-non-tag tail at stream end. */
  finish(): string {
    if (this.suppressing) return '';
    const out = this.tail;
    this.tail = '';
    return out;
  }
}
