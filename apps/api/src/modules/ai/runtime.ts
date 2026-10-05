import { randomUUID } from 'node:crypto';
import { searchSchema } from '../search/contracts';
import { providerReply, PROMPT_VERSION, RULE_VERSION } from './contracts';
export function redactQuery(value: string) {
  return value
    .replace(/https?:\/\/\S+/giu, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/gu, '[phone]')
    .slice(0, 2000);
}
export function interpretSearch(value: string) {
  const safe = redactQuery(value),
    lower = safe.toLocaleLowerCase('ru');
  const rooms = lower.match(/(?:^|\s)([1-9])\s*(?:комнат|к[ -]|к$)/u)?.[1];
  const foreignCurrency = /(?:€|\$|\busd\b|\beur\b|доллар|евро)/iu.test(lower);
  const max = foreignCurrency
    ? null
    : lower.match(/до\s*(\d+(?:[.,]\d+)?)\s*(млн|миллион|тыс|тысяч)/u);
  return searchSchema.parse({
    q: safe
      .replace(
        /(?:купить|покупка|снять|аренда|квартир[а-я]*|москв[а-я]*|(?:^|\s)[1-9]\s*комнат[а-я]*|до\s*\d+(?:[.,]\d+)?\s*(?:млн|миллион[а-я]*|тыс\.?|тысяч[а-я]*)|\[(?:email|phone|link)\])/giu,
        ' ',
      )
      .replace(/(?:^|\s)в(?=\s|$)/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    ...(lower.includes('квартир') ? { category: 'apartment' } : {}),
    ...(lower.includes('куп')
      ? { dealType: 'sale' }
      : lower.includes('снят') || lower.includes('аренд')
        ? { dealType: 'long_rent' }
        : {}),
    ...(lower.includes('моск') ? { locality: 'Москва' } : {}),
    ...(max
      ? {
          price: {
            max:
              Number(max[1]!.replace(',', '.')) *
              (max[2]!.startsWith('м') ? 1000000 : 1000),
          },
        }
      : {}),
    attributes: rooms
      ? { rooms: { min: Number(rooms), max: Number(rooms) } }
      : {},
  });
}
export interface ProviderPort {
  generate(input: unknown, signal: AbortSignal): Promise<unknown>;
}
interface Options {
  capability: string;
  context: unknown;
  fallback: unknown;
  enabled(): Promise<boolean>;
  timeoutMs?: number;
  maxCostMicros?: number;
  provider: ProviderPort;
}
export async function runAi(options: Options) {
  const requestId = randomUUID();
  const started = Date.now(),
    cap = options.maxCostMicros ?? 100000;
  let attempts = 0,
    costMicros = 0,
    inputTokens = 0,
    outputTokens = 0,
    modelVersion = 'none';
  const answer = (
    reason: string,
    reply?: ReturnType<typeof providerReply.parse>,
  ) => ({
    mode: reply ? 'ai' : 'fallback',
    reason,
    result: options.fallback,
    ...(reply
      ? {
          advice: reply.suggestion,
          ...(options.capability === 'search' && reply.filters
            ? { suggestedFilters: reply.filters }
            : {}),
        }
      : {}),
    confidence: reply?.confidence ?? 0,
    requiresHumanReview: true,
    promptVersion: PROMPT_VERSION,
    ruleVersion: RULE_VERSION,
    modelVersion,
    attempts,
    latencyMs: Date.now() - started,
    inputTokens,
    outputTokens,
    costMicros,
  });
  if (!(await options.enabled())) return answer('disabled');
  for (let i = 0; i < 2; i++) {
    if (!(await options.enabled())) return answer('disabled');
    attempts++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        options.provider.generate(
          {
            capability: options.capability,
            requestId,
            limits: { maxCostMicros: cap, maxOutputTokens: 1000 },
            promptVersion: PROMPT_VERSION,
            context: options.context,
          },
          controller.signal,
        ),
        new Promise<never>((_done, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('deadline'));
          }, options.timeoutMs ?? 3000);
        }),
      ]);
      const reply = providerReply.parse(raw);
      if (
        reply.usage.costMicros > cap ||
        reply.usage.outputTokens > 1000 ||
        (reply.filters && options.capability !== 'search')
      )
        throw new Error('invalid_output');
      costMicros += reply.usage.costMicros;
      inputTokens += reply.usage.inputTokens;
      outputTokens += reply.usage.outputTokens;
      modelVersion = reply.modelVersion;
      if (!(await options.enabled())) return answer('disabled');
      return answer('generated', reply);
    } catch {
      // Unknown provider usage is not reported as actual spend. The caller keeps
      // the per-attempt reservation separate until this invocation settles.
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return answer('provider_unavailable');
}
