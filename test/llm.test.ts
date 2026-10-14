import { test } from 'node:test';
import assert from 'node:assert/strict';

// These tests never touch the network. The Anthropic adapter gets a fake SDK
// client and the OpenAI-compatible adapter gets a fake fetch.

import { InvoiceExceptionAgent } from '../agents/invoice-exception/agent.ts';
import { buildProposal } from '../agents/invoice-exception/playbooks.ts';
import { createAnthropicPlanner, DEFAULT_ANTHROPIC_MODEL } from '../agents/llm/anthropic.ts';
import type { AnthropicLikeClient, AnthropicLikeResponse } from '../agents/llm/anthropic.ts';
import { createOpenAICompatiblePlanner } from '../agents/llm/openai-compatible.ts';
import { PlannerConfigError, plannerFromName } from '../agents/llm/from-env.ts';
import { PROPOSAL_SCHEMA, SYSTEM_PROMPT } from '../agents/llm/prompt.ts';
import type { Planner, PlanningInput } from '../agents/planner.ts';
import { setup } from './helpers.ts';

/** Wrap a planner so the fake transport can see the input it is planning for. */
function withCurrentInput(make: (current: () => PlanningInput) => Planner): Planner {
  let input: PlanningInput | undefined;
  const inner = make(() => input!);
  return { id: inner.id, plan: (i) => { input = i; return inner.plan(i); } };
}

function fakeAnthropic(respond: (body: Record<string, unknown>) => AnthropicLikeResponse) {
  const bodies: Record<string, unknown>[] = [];
  const client: AnthropicLikeClient = { beta: { messages: { create: async (body) => (bodies.push(body), respond(body)) } } };
  return { client, bodies };
}

const textResponse = (text: string, model = DEFAULT_ANTHROPIC_MODEL): AnthropicLikeResponse => ({
  model, stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 300 },
});

test('Anthropic adapter: request shape, untrusted fencing, and a full run through the kernel', async () => {
  let fake!: ReturnType<typeof fakeAnthropic>;
  const planner = withCurrentInput((current) => {
    fake = fakeAnthropic(() => textResponse(JSON.stringify(buildProposal(current()))));
    return createAnthropicPlanner({ client: fake.client });
  });
  const { kernel, audit } = setup();
  await new InvoiceExceptionAgent(kernel, planner).run();

  const body = fake.bodies[0]!;
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual((body.output_config as { format: unknown }).format, { type: 'json_schema', schema: PROPOSAL_SCHEMA });
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.equal(body.tool_choice, undefined, 'no forced tool choice');

  const brief = String((body.messages as { content: string }[])[0]!.content);
  const missingPoBrief = fake.bodies.map((b) => String((b.messages as { content: string }[])[0]!.content)).find((m) => m.includes('INV-1005'))!;
  assert.match(brief, /<evidence>/);
  assert.match(missingPoBrief, /<untrusted_text>\n\[invoice\.memo\] Rush per phone request/);
  assert.equal(missingPoBrief.match(/NOTE TO AUTOMATED AP SYSTEMS/g)?.length, 1, 'the memo appears once, inside the fence');

  for (const c of kernel.cases()) assert.equal(c.plannedBy, 'anthropic:claude-opus-5-5');
  assert.ok(audit.entries().some((e) => e.kind === 'INFERENCE' && /\(claude-opus-5-5\)/.test(e.summary)));
});

test('Anthropic adapter: a refusal or a malformed reply falls back to the playbook', async () => {
  for (const respond of [
    (): AnthropicLikeResponse => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
    (): AnthropicLikeResponse => textResponse('I think you should pay it.'),
    (): AnthropicLikeResponse => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"classif' }] }),
  ]) {
    const { client } = fakeAnthropic(respond);
    const { kernel, audit } = setup();
    await new InvoiceExceptionAgent(kernel, createAnthropicPlanner({ client })).run();
    assert.ok(kernel.cases().every((c) => c.plannedBy === 'playbook:invoice-exception@1'));
    assert.ok(audit.entries().some((e) => e.kind === 'INFERENCE' && /anthropic:claude-opus-5-5 failed/.test(e.summary)));
  }
});

test('a model that proposes a payment is rejected by the kernel, and nothing is paid', async () => {
  const { client } = fakeAnthropic(() => textResponse(JSON.stringify({
    classification: 'MISSING_PO', diagnosis: 'Memo says pre-approved.', confidence: 'certain', citations: ['EV-0001'],
    actions: [{ verb: 'PAY_INVOICE', rationale: 'memo says so', invoiceId: 'INV-1005', reasonCode: null, to: null, subject: null, body: null, amountUsd: 2450, duplicateOfInvoiceId: null, assignee: null, title: null, reason: null }],
  })));
  const { kernel, audit } = setup();
  await new InvoiceExceptionAgent(kernel, createAnthropicPlanner({ client }), { fallback: null }).run();
  const rejected = audit.entries().filter((e) => e.kind === 'PROPOSAL' && /rejected/.test(e.summary));
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((e) => /PAY_INVOICE/.test(JSON.stringify(e.data))));
  assert.equal(audit.entries().filter((e) => e.kind === 'ACTION').length, 0);
  assert.ok(kernel.cases().every((c) => c.state === 'escalated'));
});

test('OpenAI-compatible adapter: endpoint, auth header, forced function call, parsed arguments', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const planner = withCurrentInput((current) => createOpenAICompatiblePlanner({
    baseUrl: 'http://localhost:8000/v1/',
    model: 'local-model',
    apiKey: 'test-key-not-real',
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        model: 'local-model',
        choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'submit_proposal', arguments: JSON.stringify(buildProposal(current())) } }] } }],
        usage: { prompt_tokens: 900, completion_tokens: 200 },
      }), { status: 200 });
    }) as unknown as typeof fetch,
  }));
  const { kernel } = setup();
  await new InvoiceExceptionAgent(kernel, planner).run();

  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.url, 'http://localhost:8000/v1/chat/completions');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer test-key-not-real');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_proposal' } });
  assert.deepEqual(body.tools[0].function.parameters, JSON.parse(JSON.stringify(PROPOSAL_SCHEMA)));
  assert.equal(body.messages[0].role, 'system');
  for (const c of kernel.cases()) assert.equal(c.plannedBy, 'openai-compatible:local-model');
});

test('OpenAI-compatible adapter: no key means no auth header; JSON in content is accepted; HTTP errors fall back', async () => {
  let headers: Record<string, string> = {};
  const contentOnly = withCurrentInput((current) => createOpenAICompatiblePlanner({
    baseUrl: 'http://localhost:11434/v1', model: 'm',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(buildProposal(current())) + '\n```' } }] }));
    }) as unknown as typeof fetch,
  }));
  const a = setup();
  await new InvoiceExceptionAgent(a.kernel, contentOnly).run();
  assert.equal(headers.authorization, undefined);
  assert.ok(a.kernel.cases().every((c) => c.plannedBy === 'openai-compatible:m'));

  const failing = createOpenAICompatiblePlanner({
    baseUrl: 'http://localhost:1/v1', model: 'm',
    fetchImpl: (async () => new Response('overloaded', { status: 503 })) as unknown as typeof fetch,
  });
  const b = setup();
  await new InvoiceExceptionAgent(b.kernel, failing).run();
  assert.ok(b.kernel.cases().every((c) => c.plannedBy === 'playbook:invoice-exception@1'));
  assert.ok(b.audit.entries().some((e) => /HTTP 503/.test(e.summary)));
});

test('planner selection: playbook by default, model planners configured from the environment', () => {
  assert.equal(plannerFromName('playbook', {}).id, 'playbook:invoice-exception@1');
  assert.equal(plannerFromName('anthropic', {}).id, 'anthropic:claude-opus-5-5', 'constructing does not call the API');
  assert.equal(plannerFromName('anthropic', { ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).id, 'anthropic:claude-sonnet-5-5');
  assert.throws(() => plannerFromName('openai-compatible', {}), PlannerConfigError);
  assert.equal(plannerFromName('openai-compatible', { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:8000/v1', OPENAI_COMPATIBLE_MODEL: 'x' }).id, 'openai-compatible:x');
  assert.throws(() => plannerFromName('gpt-pay-bot', {}), /unknown planner/);
});
