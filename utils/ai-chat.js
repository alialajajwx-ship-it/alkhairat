// AI provider client for the store chatbot.
//
// Speaks the OpenAI-compatible Chat Completions API that NVIDIA's build
// endpoint (https://build.nvidia.com) exposes, and walks the configured model
// list IN ORDER: when a model refuses (rate limit, quota, outage, a bad
// request the model can't take) the next one is tried immediately instead of
// the request failing.
//
// Two guarantees keep a chat reply fast and from ever hanging:
//   1. Every single model call is bounded by MODEL_TIMEOUT_MS, and a whole
//      turn is bounded by TOTAL_BUDGET_MS — a dead provider can never make the
//      customer wait for minutes.
//   2. A model that times out or is gone (401/403/404/410) is remembered as
//      unhealthy for a cooldown, so later requests skip it instantly instead of
//      paying its timeout again.
//
// Configuration is read lazily from process.env so importing this module never
// depends on the environment being loaded yet.

/**
 * The model fallback chain, in priority order. These are models that actually
 * respond on build.nvidia.com; the previous list included model IDs that hang
 * until timeout, which is what made the assistant appear to never reply.
 * `NVIDIA_MODELS` (comma separated) overrides the list.
 */
export const DEFAULT_MODELS = [
  'openai/gpt-oss-20b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'meta/llama-3.2-11b-vision-instruct'
];

/** A single provider call may not take longer than this. */
const MODEL_TIMEOUT_MS = 12000;
/** A whole assistant turn (all rounds, all models) may not take longer. */
const TOTAL_BUDGET_MS = 30000;
/** How long a dead/unreachable model is skipped before being retried. */
const FAILED_COOLDOWN_MS = 5 * 60 * 1000;
/** Don't even start a model call with less than this much budget left. */
const MIN_ATTEMPT_MS = 1200;

/** `${baseUrl}|${model}` → timestamp until which the model is skipped. */
const unhealthyUntil = new Map();

function modelList() {
  const raw = String(process.env.NVIDIA_MODELS || '').trim();
  if (!raw) return DEFAULT_MODELS;
  const list = raw.split(',').map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

/**
 * Env var name for a model's own key, e.g.
 * `deepseek-ai/deepseek-v4.1-flash` → `NVIDIA_API_KEY_DEEPSEEK_AI_DEEPSEEK_V4_1_FLASH`.
 * Falls back to the shared `NVIDIA_API_KEY`.
 */
export function apiKeyEnvName(model) {
  return 'NVIDIA_API_KEY_' + String(model).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function apiKeyFor(model) {
  return String(process.env[apiKeyEnvName(model)] || process.env.NVIDIA_API_KEY || '').trim();
}

function baseUrl() {
  return String(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1')
    .trim()
    .replace(/\/+$/, '');
}

/** True when at least one model has an API key configured. */
export function isChatConfigured() {
  return modelList().some((model) => !!apiKeyFor(model));
}

/** Which configured models currently have a key (safe to log — no secrets). */
export function configuredModels() {
  return modelList().filter((model) => !!apiKeyFor(model));
}

function isFatalStatus(status) {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/**
 * One Chat Completions request against a single model.
 * Never throws — a provider failure comes back as `{ ok: false, ... }` so the
 * caller can move on to the next model. `timedOut` marks a call that ran into
 * the per-model deadline (a hanging provider).
 */
async function callModel({ model, messages, tools, timeoutMs = MODEL_TIMEOUT_MS }) {
  const apiKey = apiKeyFor(model);
  if (!apiKey) return { ok: false, error: 'لا يوجد مفتاح API لهذا النموذج', skipped: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages,
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 1024,
      stream: false
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      const providerMessage =
        (data && (data.error?.message || data.error || data.message || data.detail)) ||
        text.slice(0, 240) ||
        `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(providerMessage) };
    }

    const message = data?.choices?.[0]?.message;
    if (!message) return { ok: false, status: 502, error: 'رد فارغ من المزود' };

    return { ok: true, model, message, usage: data.usage || null };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    const message = timedOut ? 'انتهت مهلة الطلب' : (err?.message || 'فشل الاتصال');
    return { ok: false, status: 0, error: String(message), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a conversation, falling back through the model list until one answers.
 *
 * @param {object} options
 * @param {number} [options.timeoutMs]   per-model deadline
 * @param {number} [options.budgetMs]    total wall-clock budget for this call
 * @param {Set<string>} [options.skip]   models already known dead for this turn
 * @returns {Promise<{ ok: boolean, model?: string, message?: object,
 *                     errors?: string[] }>}
 */
export async function chatComplete({
  messages,
  tools,
  timeoutMs = MODEL_TIMEOUT_MS,
  budgetMs = TOTAL_BUDGET_MS,
  skip
} = {}) {
  const errors = [];
  const started = Date.now();
  const base = baseUrl();

  for (const model of modelList()) {
    if (skip && skip.has(model)) continue;

    const cacheKey = `${base}|${model}`;
    const until = unhealthyUntil.get(cacheKey);
    if (until && until > Date.now()) {
      errors.push(`${model}: تم تخطيه مؤقتاً (فشل سابقاً)`);
      continue;
    }

    const remaining = budgetMs - (Date.now() - started);
    if (remaining < MIN_ATTEMPT_MS) {
      errors.push(`${model}: لا يوجد وقت كافٍ ضمن المهلة`);
      break;
    }

    const attempt = await callModel({
      model,
      messages,
      tools,
      timeoutMs: Math.min(timeoutMs, remaining)
    });

    if (attempt.ok) {
      return { ok: true, model: attempt.model, message: attempt.message, usage: attempt.usage };
    }

    // A hang or a gone/unauthorized model is remembered so the next request
    // (and the next round of this one) skips it instead of paying its timeout.
    if (attempt.timedOut || isFatalStatus(attempt.status)) {
      unhealthyUntil.set(cacheKey, Date.now() + FAILED_COOLDOWN_MS);
      if (skip) skip.add(model);
    }

    if (!attempt.skipped) errors.push(`${model}: ${attempt.error}`);
  }

  return { ok: false, errors };
}

/**
 * Run a full tool-calling turn: keep asking the model until it produces a
 * plain answer (or the round budget runs out).
 *
 * A shared model skip-set and a single wall-clock deadline span every round,
 * so a turn can never multiply into "rounds × models × timeout" of waiting.
 *
 * @param {object} options
 * @param {Array} options.messages - conversation so far (system + history + user)
 * @param {Array} options.tools - OpenAI-style tool definitions
 * @param {(name: string, args: object, events: Array) => Promise<any>} options.executeTool
 * @param {number} [options.maxRounds]
 * @param {number} [options.totalBudgetMs]
 * @returns {Promise<{ ok: boolean, text?: string, model?: string,
 *                     events: Array, errors?: string[], usage?: object }>}
 */
export async function chatWithTools({
  messages,
  tools,
  executeTool,
  maxRounds = 4,
  totalBudgetMs = TOTAL_BUDGET_MS
}) {
  const convo = [...messages];
  const events = [];
  const skip = new Set();
  const deadline = Date.now() + totalBudgetMs;

  for (let round = 0; round <= maxRounds; round += 1) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      return { ok: false, errors: ['انتهت مهلة المساعد الآلي'], events };
    }

    // The last round is answered WITHOUT tools so the model must produce text
    const useTools = round < maxRounds ? tools : [];
    const res = await chatComplete({ messages: convo, tools: useTools, budgetMs: remaining, skip });
    if (!res.ok) return { ok: false, errors: res.errors, events };

    const message = res.message || {};
    convo.push(message);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!toolCalls.length) {
      return { ok: true, text: String(message.content || '').trim(), model: res.model, events, usage: res.usage };
    }

    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}') || {}; } catch { args = {}; }
      let result;
      try {
        result = await executeTool(call.function?.name, args, events);
      } catch (err) {
        result = { error: err?.message || 'فشل تنفيذ الأداة' };
      }
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? {}).slice(0, 4000)
      });
    }
  }

  return { ok: false, errors: ['تجاوز المساعد عدد المحاولات المسموح'], events };
}
