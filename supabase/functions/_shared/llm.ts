/**
 * Minimal OpenAI-compatible chat-completions client.
 *
 * No third-party SDK: a single `fetch` against `${baseUrl}/chat/completions`.
 * The two providers expected here (OpenAI and its drop-in clones) share this
 * wire format, so the assistant can be pointed at either by changing env only.
 *
 * Everything is explicit:
 *   * trailing slashes on the base URL are trimmed so `${base}/chat/completions`
 *     never becomes `//chat/completions`;
 *   * a failed call throws `LlmHttpError` carrying the numeric HTTP status, so
 *     the caller can distinguish "not configured / bad key" from "upstream 5xx";
 *   * the request is hard-capped at 30 seconds with `AbortSignal.timeout` so a
 *     hung upstream can never pin an Edge Function invocation open.
 */

/** A tool call exactly as the OpenAI chat-completions response returns it. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** Raw JSON string, parsed defensively by the caller. */
    arguments: string;
  };
}

/** One message in the conversation sent to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Present on an assistant message that requested tools. */
  tool_calls?: ToolCall[];
  /** Present on a `tool` message, tying it back to the request. */
  tool_call_id?: string;
  name?: string;
}

/** A function the model is allowed to call. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** e.g. `{ type: 'json_object' }` for the strict-JSON intent fallback. */
  responseFormat?: Record<string, unknown>;
  temperature?: number;
}

/** Typed transport error carrying the upstream HTTP status (0 = never reached). */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string | undefined;

  constructor(status: number, message: string, body?: string) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 30-second hard timeout for every upstream call. */
const REQUEST_TIMEOUT_MS = 30_000;

export async function chatCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResult> {
  const baseUrl = params.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }
  if (params.responseFormat) {
    body.response_format = params.responseFormat;
  }
  if (typeof params.temperature === 'number') {
    body.temperature = params.temperature;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmHttpError(
      0,
      `LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new LlmHttpError(response.status, `LLM responded with HTTP ${response.status}`, text);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new LlmHttpError(response.status, 'LLM returned a non-JSON body', text);
  }

  const record = isRecord(payload) ? payload : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};

  const content = typeof message.content === 'string' ? message.content : null;
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? (message.tool_calls as ToolCall[])
    : [];

  const usageRecord = isRecord(record.usage) ? record.usage : {};
  const usage: ChatCompletionUsage = {
    promptTokens: toNonNegativeInt(usageRecord.prompt_tokens),
    completionTokens: toNonNegativeInt(usageRecord.completion_tokens),
    totalTokens: toNonNegativeInt(usageRecord.total_tokens),
  };

  return { content, toolCalls, usage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
