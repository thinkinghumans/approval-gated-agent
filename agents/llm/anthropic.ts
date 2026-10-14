import { PlannerError } from '../planner.ts';
import type { PlanResult, Planner, PlanningInput } from '../planner.ts';
import { PROPOSAL_SCHEMA, SYSTEM_PROMPT, parseJsonText, renderCaseBrief } from './prompt.ts';

// Optional planner backed by the Anthropic Messages API, through the official
// SDK (@anthropic-ai/sdk, an optional dependency loaded only when this planner
// is selected). The model returns the proposal through structured outputs
// (output_config.format with the proposal JSON schema). Nothing it returns is
// trusted: the kernel validates it exactly as it validates the playbooks.
//
// Credentials: the SDK reads ANTHROPIC_API_KEY (or another configured
// credential source). Nothing here is required to run the demo.

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** The slice of the SDK client this adapter uses. Tests pass a fake. */
export interface AnthropicLikeClient {
  beta: { messages: { create(body: Record<string, unknown>): Promise<AnthropicLikeResponse> } };
}

export interface AnthropicLikeResponse {
  model?: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicPlannerOptions {
  model?: string;
  apiKey?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: AnthropicLikeClient;
}

const SDK_MODULE: string = '@anthropic-ai/sdk';

export function createAnthropicPlanner(opts: AnthropicPlannerOptions = {}): Planner {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  let client = opts.client;

  return {
    id: `anthropic:${model}`,
    async plan(input: PlanningInput): Promise<PlanResult> {
      client ??= await loadSdkClient(opts.apiKey);
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.effort ?? 'high', format: { type: 'json_schema', schema: PROPOSAL_SCHEMA } },
        // On a safety decline, let the API re-run the request on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: renderCaseBrief(input) }],
      });

      if (res.stop_reason === 'refusal') {
        throw new PlannerError(`model declined the request (${res.stop_details?.category ?? 'no category'})`);
      }
      if (res.stop_reason === 'max_tokens') throw new PlannerError('model output was cut off at max_tokens');
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (!text.trim()) throw new PlannerError('model returned no text content');

      return {
        raw: parseJsonText(text),
        model: res.model ?? model,
        usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
      };
    },
  };
}

async function loadSdkClient(apiKey?: string): Promise<AnthropicLikeClient> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SDK_MODULE)) as Record<string, unknown>;
  } catch {
    throw new PlannerError('the Anthropic planner needs the optional dependency @anthropic-ai/sdk (npm install @anthropic-ai/sdk)');
  }
  const Ctor = (mod.default ?? mod.Anthropic) as new (o: Record<string, unknown>) => AnthropicLikeClient;
  return new Ctor(apiKey ? { apiKey } : {});
}
