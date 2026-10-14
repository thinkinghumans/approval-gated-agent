import { PlannerError } from '../planner.ts';
import type { PlanResult, Planner, PlanningInput } from '../planner.ts';
import { PROPOSAL_SCHEMA, SYSTEM_PROMPT, parseJsonText, renderCaseBrief } from './prompt.ts';

// Optional planner for any endpoint that speaks the OpenAI chat-completions
// format: a hosted provider, a gateway, or a model served on your own
// hardware (vLLM, llama.cpp server, Ollama and similar). The proposal comes
// back as the arguments of a forced function call, with a fallback to JSON in
// the message text for servers that ignore tool_choice.
//
// Configuration comes from the caller (see from-env.ts). The API key is
// optional because many self-hosted servers do not use one.

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ChatCompletion {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { type?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAICompatiblePlanner(opts: OpenAICompatibleOptions): Planner {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    id: `openai-compatible:${opts.model}`,
    async plan(input: PlanningInput): Promise<PlanResult> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      const res = await doFetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: renderCaseBrief(input) },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'submit_proposal',
              description: 'Submit the proposal for this case. Call exactly once.',
              parameters: PROPOSAL_SCHEMA,
            },
          }],
          tool_choice: { type: 'function', function: { name: 'submit_proposal' } },
        }),
      });
      if (!res.ok) {
        throw new PlannerError(`endpoint returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as ChatCompletion;
      const message = data.choices?.[0]?.message;
      if (!message) throw new PlannerError('endpoint returned no choices');
      if (message.refusal) throw new PlannerError('model declined the request');

      const call = message.tool_calls?.find((t) => t.function?.name === 'submit_proposal');
      const raw = call?.function?.arguments !== undefined
        ? parseJsonText(call.function.arguments)
        : message.content
          ? parseJsonText(message.content)
          : (() => { throw new PlannerError('model returned neither a tool call nor JSON text'); })();

      return {
        raw,
        model: data.model ?? opts.model,
        usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      };
    },
  };
}
