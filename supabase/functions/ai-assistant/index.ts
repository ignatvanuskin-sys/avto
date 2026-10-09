/**
 * ai-assistant — optional conversational helper for the booking PWA.
 *
 * POST body: { slug, scope: 'client' | 'owner', message, history?, serviceKey? }
 *
 * Scope separation is a SECURITY boundary, not a prompt string:
 *   * `client` may only touch the *public* surface (available_slots,
 *     public_tenant_profile). It can never see another customer's data, payments
 *     or the owner's statistics — those tools are simply not in its allow-list.
 *   * `owner` may use owner-only data, but ONLY after membership is verified
 *     server-side against `owner_tenant_context` with the caller's own token.
 *
 * The model NEVER supplies SQL or a tenant id. It only names a tool from a fixed
 * allow-list with simple parameters (an ISO date range and a service key); this
 * function constructs the actual RPC call and injects the tenant id itself.
 *
 * The LLM is optional: when LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are missing
 * this endpoint answers 503, while ordinary booking keeps working untouched.
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, anonClient } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';
import {
  type ChatMessage,
  chatCompletion,
  type ChatCompletionUsage,
  LlmHttpError,
  type ToolDefinition,
} from '../_shared/llm.ts';

type Scope = 'client' | 'owner';

/** Fixed, per-scope tool allow-lists. This is the security boundary. */
const CLIENT_TOOLS = ['public_tenant_profile', 'available_slots'] as const;
const OWNER_TOOLS = ['public_tenant_profile', 'available_slots', 'owner_stats'] as const;

/** A bounded tool loop: at most this many rounds that may call a tool. */
const MAX_TOOL_ROUNDS = 3;

const DEGRADED_REPLY =
  'Извините, ассистент сейчас не может ответить. Это не мешает записи — вы можете записаться вручную на странице салона.';

interface ResolvedPeriod {
  from: string;
  to: string;
  timezone: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

/** Today's date (YYYY-MM-DD) in the tenant's timezone. */
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Accept only a strict ISO calendar date; anything else is ignored. */
function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/** Parse a model tool-call argument string defensively. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a loose JSON object out of model text (strips ``` fences). */
function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(requestOrigin(req));
  const fail = (code: string, message: string, status: number): Response =>
    jsonResponse({ ok: false, code, message }, status, cors);

  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (req.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 'use POST', 405);
  }

  // ---- Configuration (the assistant is optional; booking is not) ----------
  const baseUrl = Deno.env.get('LLM_BASE_URL')?.trim();
  const apiKey = Deno.env.get('LLM_API_KEY')?.trim();
  const model = Deno.env.get('LLM_MODEL')?.trim();
  if (!baseUrl || !apiKey || !model) {
    return fail(
      'LLM_NOT_CONFIGURED',
      'The AI assistant is not configured. Booking still works without it.',
      503,
    );
  }

  let admin: SupabaseClient;
  let publicClient: SupabaseClient;
  try {
    admin = adminClient();
    // The public RPCs are granted to `anon`; a public-surface tool call must not
    // run with more authority than the anonymous booking page has.
    publicClient = anonClient();
  } catch (error) {
    console.error('ai-assistant: clients not configured', errorMessage(error));
    return fail('INTERNAL', 'internal error', 500);
  }

  const raw: unknown = await req.json().catch(() => null);
  if (!isRecord(raw)) {
    return fail('INVALID_REQUEST', 'request body must be a JSON object', 400);
  }

  const slug = isNonEmptyString(raw.slug) ? raw.slug.trim() : '';
  const scope: Scope | null = raw.scope === 'client' || raw.scope === 'owner' ? raw.scope : null;
  const message = isNonEmptyString(raw.message) ? raw.message.trim() : '';
  const serviceKeyHint = isNonEmptyString(raw.serviceKey) ? raw.serviceKey.trim() : null;

  if (!slug) return fail('INVALID_REQUEST', 'slug is required', 400);
  if (!scope) return fail('INVALID_REQUEST', "scope must be 'client' or 'owner'", 400);
  if (!message) return fail('INVALID_REQUEST', 'message is required', 400);

  try {
    // ---- Resolve the tenant server-side -----------------------------------
    const tenantResult = await admin
      .from('tenants')
      .select('id, slug, name, timezone, ai_enabled, ai_calls_per_day, ai_persona')
      .eq('slug', slug)
      .maybeSingle();
    if (tenantResult.error) {
      console.error('ai-assistant: tenant lookup failed', tenantResult.error.message);
      return fail('INTERNAL', 'internal error', 500);
    }
    const tenant = isRecord(tenantResult.data) ? tenantResult.data : null;
    if (!tenant || typeof tenant.id !== 'string') {
      return fail('TENANT_NOT_FOUND', `unknown tenant '${slug}'`, 404);
    }
    const tenantId = tenant.id;
    const timezone = typeof tenant.timezone === 'string' ? tenant.timezone : 'UTC';
    const tenantName = typeof tenant.name === 'string' ? tenant.name : slug;

    // ---- Honour ai_enabled ------------------------------------------------
    if (tenant.ai_enabled !== true) {
      return fail('AI_DISABLED', 'the AI assistant is disabled for this studio', 403);
    }

    // ---- Budget first (per tenant, limit read from the tenant row) --------
    const budget = await admin.rpc('consume_ai_budget', {
      p_tenant_id: tenantId,
      p_call_limit: typeof tenant.ai_calls_per_day === 'number' ? tenant.ai_calls_per_day : 0,
      p_window_seconds: 86400,
    });
    if (budget.error) {
      console.error('ai-assistant: budget check failed', budget.error.message);
      return fail('INTERNAL', 'internal error', 500);
    }
    const budgetRow = Array.isArray(budget.data) ? budget.data[0] : budget.data;
    if (isRecord(budgetRow) && budgetRow.allowed === false) {
      return fail('AI_BUDGET_EXHAUSTED', 'the daily AI budget for this studio is exhausted', 429);
    }

    // ---- Scope separation: verify owner membership server-side ------------
    const allowedTools: readonly string[] = scope === 'owner' ? OWNER_TOOLS : CLIENT_TOOLS;
    let ownerClient: SupabaseClient | null = null;

    if (scope === 'owner') {
      const authorization = req.headers.get('authorization') ?? undefined;
      ownerClient = anonClient(authorization);
      const context = await ownerClient.rpc('owner_tenant_context');
      if (context.error) {
        console.error('ai-assistant: owner context failed', context.error.message);
        return fail('INTERNAL', 'internal error', 500);
      }
      const contexts = Array.isArray(context.data) ? context.data : [];
      const match = contexts.find((entry) => {
        if (!isRecord(entry)) return false;
        const sameSlug = typeof entry.slug === 'string' && entry.slug.toLowerCase() === slug.toLowerCase();
        const sameId = entry.tenantId === tenantId;
        return sameSlug || sameId;
      });
      const role = isRecord(match) && typeof match.role === 'string' ? match.role : null;
      if (!match || (role !== 'owner' && role !== 'manager')) {
        return fail('NOT_A_MEMBER', 'only owners and managers may use the owner assistant', 403);
      }
    }

    // ---- Period contract: resolved in the TENANT timezone -----------------
    const today = todayInTimezone(timezone);
    const period: ResolvedPeriod = { from: today, to: today, timezone };

    // ---- Server-side tool execution ---------------------------------------
    let slotsResult: unknown[] | null = null;
    let statsResult: unknown = null;
    let lastIntent: string | undefined;
    let executedTool = false;

    const loadFirstServiceKey = async (): Promise<string | null> => {
      const { data } = await publicClient.rpc('public_tenant_profile', { p_slug: slug });
      if (!isRecord(data)) return null;
      const services = Array.isArray(data.services) ? data.services : [];
      const first = services.find((s) => isRecord(s) && typeof s.key === 'string');
      return isRecord(first) && typeof first.key === 'string' ? first.key : null;
    };

    /**
     * Execute one allow-listed tool. The model supplies only simple params; the
     * slug / tenant id / date bounds are injected here.
     */
    const executeTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const from = normalizeIsoDate(args.from) ?? period.from;
      const to = normalizeIsoDate(args.to) ?? from;
      period.from = from;
      period.to = to;

      if (name === 'public_tenant_profile') {
        const { data, error } = await publicClient.rpc('public_tenant_profile', { p_slug: slug });
        if (error) return { error: error.message };
        lastIntent = 'profile';
        return data;
      }

      if (name === 'available_slots') {
        const requested = isNonEmptyString(args.serviceKey)
          ? args.serviceKey.trim()
          : serviceKeyHint;
        const serviceKey = requested ?? (await loadFirstServiceKey());
        if (!serviceKey) return { error: 'no active service to check' };
        const { data, error } = await publicClient.rpc('available_slots', {
          p_tenant_slug: slug,
          p_service_key: serviceKey,
          p_from: from,
          p_to: to,
        });
        if (error) return { error: error.message };
        slotsResult = Array.isArray(data) ? data : [];
        lastIntent = 'slots';
        return slotsResult.slice(0, 40);
      }

      if (name === 'owner_stats') {
        // Only reachable for a verified owner scope: `ownerClient` exists then.
        if (!ownerClient) return { error: 'not permitted' };
        const { data, error } = await ownerClient.rpc('owner_stats', {
          p_tenant_id: tenantId,
          p_from: from,
          p_to: to,
        });
        if (error) return { error: error.message };
        statsResult = data;
        lastIntent = 'stats';
        return data;
      }

      return { error: 'tool_not_permitted' };
    };

    // ---- Tool definitions, restricted to the scope's allow-list -----------
    const toolCatalogue: Record<string, ToolDefinition> = {
      public_tenant_profile: {
        type: 'function',
        function: {
          name: 'public_tenant_profile',
          description: 'Публичная информация о салоне: услуги, цены, часы работы.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      available_slots: {
        type: 'function',
        function: {
          name: 'available_slots',
          description: 'Свободные окна записи в салоне за период.',
          parameters: {
            type: 'object',
            properties: {
              serviceKey: { type: 'string', description: 'Ключ услуги (необязательно).' },
              from: { type: 'string', description: 'Начало периода, YYYY-MM-DD.' },
              to: { type: 'string', description: 'Конец периода, YYYY-MM-DD.' },
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
      },
      owner_stats: {
        type: 'function',
        function: {
          name: 'owner_stats',
          description: 'Статистика салона за период (только для владельца/менеджера).',
          parameters: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Начало периода, YYYY-MM-DD.' },
              to: { type: 'string', description: 'Конец периода, YYYY-MM-DD.' },
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
      },
    };
    const toolDefinitions: ToolDefinition[] = allowedTools.map((n) => toolCatalogue[n]);

    // ---- Conversation ------------------------------------------------------
    const persona = isNonEmptyString(tenant.ai_persona) ? tenant.ai_persona.trim() : '';
    const scopeRule = scope === 'client'
      ? 'Обслуживай только обычных клиентов салона. Никогда не упоминай данные других клиентов, платежи или статистику владельца — у тебя нет доступа к ним.'
      : 'Ты помогаешь владельцу или менеджеру салона и можешь использовать статистику салона.';
    const systemPrompt = [
      `Ты — вежливый ассистент салона «${tenantName}». Отвечай кратко и по-русски.`,
      scopeRule,
      'Пользуйся только данными из доступных инструментов и никогда не придумывай числа, цены или окна записи.',
      'Если нужны данные — вызови инструмент; если вопрос не про салон, вежливо откажись.',
      persona,
    ].filter((part) => part.length > 0).join(' ');

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(raw.history)) {
      for (const entry of raw.history) {
        if (!isRecord(entry)) continue;
        const role = entry.role;
        if (role !== 'user' && role !== 'assistant') continue;
        if (typeof entry.content !== 'string') continue;
        messages.push({ role, content: entry.content });
      }
    }
    messages.push({ role: 'user', content: message });

    const recordUsage = async (usage: ChatCompletionUsage): Promise<void> => {
      try {
        await admin.rpc('record_ai_tokens', {
          p_tenant_id: tenantId,
          p_prompt_tokens: usage.promptTokens,
          p_completion_tokens: usage.completionTokens,
        });
      } catch (error) {
        console.error('ai-assistant: token recording failed', errorMessage(error));
      }
    };

    let answer: string | null = null;

    // ---- Bounded native tool loop (max MAX_TOOL_ROUNDS tool rounds) -------
    for (let round = 0; round < MAX_TOOL_ROUNDS && !answer; round += 1) {
      const completion = await chatCompletion({
        baseUrl,
        apiKey,
        model,
        messages,
        tools: toolDefinitions,
        temperature: 0.2,
      });
      await recordUsage(completion.usage);

      if (completion.toolCalls.length === 0) {
        answer = completion.content;
        break;
      }

      messages.push({
        role: 'assistant',
        content: completion.content ?? null,
        tool_calls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        const name = isNonEmptyString(call.function?.name) ? call.function.name : '';
        if (!allowedTools.includes(name)) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'tool_not_permitted' }),
          });
          continue;
        }
        executedTool = true;
        const outcome = await executeTool(name, parseArguments(call.function?.arguments));
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome ?? null),
        });
      }
    }

    // If tools were exhausted with no prose yet, force one plain-text answer.
    if (!answer) {
      const completion = await chatCompletion({ baseUrl, apiKey, model, messages, temperature: 0.2 });
      await recordUsage(completion.usage);
      answer = completion.content;
    }

    // ---- JSON intent fallback --------------------------------------------
    // When the native function-calling protocol produced no executed tool (e.g.
    // a provider that ignores `tools`), ask for a strict JSON object and route
    // the intent through the SAME server-side handlers. This is isolated in its
    // own try/catch: a provider without `response_format` support must not turn
    // a usable prose answer into an error.
    if (!executedTool) {
      try {
        const fallback = await chatCompletion({
          baseUrl,
          apiKey,
          model,
          messages: [
            ...messages,
            {
              role: 'user',
              content:
                'Ответь строго одним JSON-объектом без пояснений: ' +
                '{"intent":"slots|profile|stats|answer","serviceKey"?:string,' +
                '"from"?:"YYYY-MM-DD","to"?:"YYYY-MM-DD","answer"?:string}. ' +
                'Не придумывай числа.',
            },
          ],
          responseFormat: { type: 'json_object' },
          temperature: 0,
        });
        await recordUsage(fallback.usage);

        const parsed = parseJsonObject(fallback.content);
        if (parsed) {
          const intent = typeof parsed.intent === 'string' ? parsed.intent : '';
          if (intent === 'slots') {
            await executeTool('available_slots', parsed);
          } else if (intent === 'profile') {
            await executeTool('public_tenant_profile', {});
          } else if (intent === 'stats' && scope === 'owner' && ownerClient) {
            await executeTool('owner_stats', parsed);
          }
          if (typeof parsed.answer === 'string' && parsed.answer.trim() !== '') {
            answer = parsed.answer.trim();
          }
        }
      } catch (error) {
        console.error('ai-assistant: intent fallback failed', errorMessage(error));
      }
    }

    // ---- Compose the reply, every figure sourced from a tool result -------
    if (!isNonEmptyString(answer)) {
      if (slotsResult) {
        answer = `Свободных окон в период с ${period.from} по ${period.to}: ${slotsResult.length}.`;
      } else if (isRecord(statsResult)) {
        const visits = statsResult.visits ?? 0;
        const completed = statsResult.completedOrders ?? 0;
        answer =
          `За период с ${period.from} по ${period.to}: визитов — ${visits}, ` +
          `завершённых работ — ${completed}.`;
      }
    }

    const degraded = !isNonEmptyString(answer);
    if (degraded) {
      answer = DEGRADED_REPLY;
    }

    const data: Record<string, unknown> = {
      reply: answer,
      scope,
      period,
      model,
    };
    if (lastIntent) data.intent = lastIntent;
    if (slotsResult) {
      // Match the client contract: `{ startAt, resourceName }` per slot.
      data.slots = slotsResult.map((slot) =>
        isRecord(slot)
          ? { startAt: slot.slot_start ?? null, resourceName: slot.slot_resource_name ?? null }
          : slot
      );
    }
    if (statsResult) data.stats = statsResult;
    if (degraded) data.degraded = true;

    return jsonResponse({ ok: true, data }, 200, cors);
  } catch (error) {
    if (error instanceof LlmHttpError) {
      console.error(`ai-assistant: LLM error (status ${error.status})`, error.message);
      return fail('LLM_ERROR', 'the assistant is temporarily unavailable', 502);
    }
    console.error('ai-assistant: unhandled error', errorMessage(error));
    return fail('INTERNAL', 'internal error', 500);
  }
});
