/** Discriminated-union Block types for api-log-viewer */

/**
 * Source tracking: where in the raw trace a Block came from
 */
export interface BlockSource {
  side: 'req' | 'resp';
  container: 'body' | 'events' | 'body_b64';
  path?: string; // e.g., "trace.req.body.input[2].content[0]" or "trace.resp.events[45]"
  event_type?: string; // for SSE: "response.output_text.delta", "response.function_call_arguments.done", etc.
  index?: number; // for array containers
}

/**
 * Citation reference (for retrieval-augmented blocks)
 */
export interface Citation {
  source: string;
  url?: string;
  title?: string;
}

/**
 * Base Block type with common fields
 */
export interface BlockBase {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'media' | 'error' | 'unknown';
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  source: BlockSource;
  created_at?: number; // unix timestamp
  token_estimate?: number; // tokens consumed
  sequence_number?: number; // order in stream
}

/**
 * Text block: plain content
 */
export interface TextBlock extends BlockBase {
  type: 'text';
  role: 'user' | 'assistant' | 'system' | 'developer';
  text: string;
  citations?: Citation[];
}

/**
 * Reasoning block: extended thinking / hidden reasoning
 * First-class in Responses protocol; echoed back to input on subsequent calls
 */
export interface ReasoningBlock extends BlockBase {
  type: 'reasoning';
  role: 'assistant';
  reasoning_text: string;
  budget_tokens?: number;
  is_encrypted?: boolean; // true if the trace contains encrypted_content instead of plaintext
}

/**
 * Tool call block: model invokes a tool
 * - kind = 'function': OpenAI-style function_call (Responses, Chat)
 * - kind = 'custom': Codex-style custom_tool_call
 * - kind = 'web_search' | 'file_search' | 'code_exec' | 'image_gen': specialized tools
 */
export interface ToolCallBlock extends BlockBase {
  type: 'tool_call';
  role: 'assistant';
  tool_id: string; // unique ID for pairing with tool_result
  tool_name: string; // name of the tool function
  kind: 'function' | 'custom' | 'web_search' | 'file_search' | 'code_exec' | 'image_gen';
  input: unknown; // parsed tool input (dict/object)
  raw_input?: string; // unparsed raw string (for in-progress deltas)
  call_id?: string; // e.g., "call_..." from OpenAI; used for linking
}

/**
 * Tool result block: tool output, echoed back to model
 */
export interface ToolResultBlock extends BlockBase {
  type: 'tool_result';
  role: 'tool';
  tool_id: string; // references ToolCallBlock.tool_id for pairing
  tool_name: string;
  result_text: string;
  is_error?: boolean;
  result_structured?: unknown; // parsed structured result if applicable
}

/**
 * Media block: binary content (image, audio, video, document, etc.)
 */
export interface MediaBlock extends BlockBase {
  type: 'media';
  role: 'user' | 'assistant';
  media_type: 'image' | 'audio' | 'video' | 'document' | 'other';
  mime_type: string; // e.g., "image/png", "application/pdf"
  url?: string;
  data_b64?: string; // base64-encoded binary data
  filename?: string;
}

/**
 * Error block: parse failure, API error, or aborted response
 */
export interface ErrorBlock extends BlockBase {
  type: 'error';
  role: 'system';
  error_type: string; // e.g., "parse_error", "api_error", "sse_frame_error"
  error_message: string;
  error_code?: string;
  http_status?: number;
}

/**
 * Unknown block: catch-all for unrecognized or unparseable blocks
 */
export interface UnknownBlock extends BlockBase {
  type: 'unknown';
  role: 'system';
  raw_data: unknown;
  block_source: string; // human description of where this came from
  parse_error?: string;
}

/**
 * Discriminated union of all Block types
 */
export type Block =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | MediaBlock
  | ErrorBlock
  | UnknownBlock;

/**
 * Timeline: ordered sequence of Blocks from a single Trace
 * Derived from a Trace by adapters (per protocol)
 */
export interface Timeline {
  trace_id: string;
  protocol: 'openai_responses' | 'openai_chat' | 'anthropic_messages' | 'google_gemini' | 'grok';
  path: string; // e.g., "/v1/responses", "/v1/messages"
  status: number; // HTTP status code
  created_at: number; // unix timestamp
  blocks: Block[];
  error?: string; // if timeline construction failed
}

// ==================== Helper Functions ====================

/**
 * Count blocks by type
 */
export function countByType(blocks: Block[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    counts[block.type] = (counts[block.type] || 0) + 1;
  }
  return counts;
}

/**
 * Find the tool_result block(s) that match a tool_call block
 * Returns all ToolResultBlock instances that reference the given tool_id
 */
export function findToolResults(
  blocks: Block[],
  tool_call_id: string
): ToolResultBlock[] {
  return blocks.filter(
    (b): b is ToolResultBlock =>
      b.type === 'tool_result' && b.tool_id === tool_call_id
  );
}

/**
 * Create a pairing map: tool_call.tool_id -> ToolResultBlock[]
 * Enables the renderer to link tool calls with their outputs visually
 */
export function buildToolPairings(blocks: Block[]): Map<string, ToolResultBlock[]> {
  const map = new Map<string, ToolResultBlock[]>();
  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call');
  const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');

  for (const call of toolCalls) {
    const results = toolResults.filter(r => r.tool_id === call.tool_id);
    if (results.length > 0) {
      map.set(call.tool_id, results);
    }
  }
  return map;
}

/**
 * Estimate total tokens in a timeline (rough heuristic)
 * Sums block token_estimate values; falls back to 4 chars = 1 token approximation
 */
export function tokenSum(blocks: Block[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.token_estimate !== undefined) {
      total += block.token_estimate;
    } else if (block.type === 'text') {
      total += Math.ceil(block.text.length / 4);
    } else if (block.type === 'reasoning') {
      total += Math.ceil(block.reasoning_text.length / 4);
    } else if (block.type === 'tool_result') {
      total += Math.ceil(block.result_text.length / 4);
    }
  }
  return total;
}

/**
 * Determine if a block should be collapsed by default in the UI
 * Rules:
 *  - reasoning blocks with large budgets should collapse
 *  - text blocks longer than N chars should collapse
 *  - error blocks should expand for debugging
 */
export function isCollapsibleByDefault(block: Block): boolean {
  if (block.type === 'error') return false; // errors always visible
  if (block.type === 'reasoning') {
    return (block.budget_tokens || 0) > 5000; // large reasoning = collapsible
  }
  if (block.type === 'text') {
    return block.text.length > 2000; // long text = collapsible
  }
  if (block.type === 'tool_result') {
    return block.result_text.length > 3000; // long output = collapsible
  }
  return false;
}

/**
 * Extract all tool calls and results in order, with pairing
 * Returns array of {call, results} tuples
 */
export function extractToolPairs(blocks: Block[]): Array<{
  call: ToolCallBlock;
  results: ToolResultBlock[];
  index: number;
}> {
  const pairings = buildToolPairings(blocks);
  const calls = blocks
    .map((b, i) => ({ block: b, index: i }))
    .filter((x): x is { block: ToolCallBlock; index: number } =>
      x.block.type === 'tool_call'
    );

  return calls.map(({ block: call, index }) => ({
    call,
    results: pairings.get(call.tool_id) || [],
    index,
  }));
}

/**
 * Filter blocks by type and optionally by role
 */
export function filterBlocks(
  blocks: Block[],
  type?: Block['type'],
  role?: Block['role']
): Block[] {
  return blocks.filter(
    b => (type === undefined || b.type === type) && (role === undefined || b.role === role)
  );
}

/**
 * Summarize a timeline as a human-readable string
 * Useful for logs and debugging
 */
export function summarizeTimeline(timeline: Timeline): string {
  const counts = countByType(timeline.blocks);
  const parts = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  return `${timeline.protocol} ${timeline.path} (${timeline.status}): ${parts}`;
}