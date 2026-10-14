import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog, AuditError } from '../kernel/audit.ts';
import { ExecutionRefused, Executor } from '../kernel/executor.ts';
import type { Authority } from '../kernel/executor.ts';
import { decide, loadPolicy } from '../kernel/policy.ts';
import { Store } from '../kernel/store.ts';
import type { Case, CaseAction } from '../kernel/types.ts';
import { VERBS, VERB_NAMES, isVerb } from '../kernel/verbs.ts';
import type { Verb } from '../kernel/verbs.ts';
import { AGENT, DANA, PRIYA, SAM, dataset, policyConfig, setup } from './helpers.ts';

function fixture() {
  const policy = loadPolicy(policyConfig());
  const store = Store.fromDataset(dataset());
  const audit = new AuditLog();
  const executor = new Executor(store, audit, policy);
  const c: Case = {
    id: 'CASE-T1', invoiceId: 'INV-1003', supplierId: 'SUP-IRONLEAF', primaryType: 'PRICE_VARIANCE',
    findings: [], evidence: [], state: 'detected', proposal: null, plannedBy: null, actions: [],
    escalationReason: null, openedAt: '2026-03-02T14:00:00.000Z',
  };
  store.cases.set(c.id, c);
  let n = 0;
  const action = (verb: string, params: Record<string, string | number>, amount = 0): CaseAction => {
    const decision = decide(policy, { verb, amountAtStakeUsd: amount, confidence: 0.85, exceptionType: 'PRICE_VARIANCE' });
    return {
      id: `ACT-T${++n}`, caseId: c.id, verb: verb as Verb, params, rationale: 'test', amountAtStakeUsd: amount, decision,
      status: decision.outcome === 'autonomous' ? 'auto_approved' : decision.outcome === 'needs_human' ? 'awaiting_human' : 'blocked',
      decidedBy: null, decidedAt: null, rejectionReason: null, result: null, executedAt: null,
    };
  };
  const standing: Authority = { kind: 'standing_approval', signedBy: SAM, policyVersion: policy.version, policyHash: policy.hash };
  return { policy, store, audit, executor, c, action, standing };
}

const PAYMENT_SHAPED = /PAY|REMIT|WIRE|ACH|TRANSFER|DISBURSE|SETTLE|BANK|FUND/;

test('the verb vocabulary contains nothing that moves money', () => {
  assert.equal(VERB_NAMES.length, 8);
  for (const v of VERB_NAMES) assert.doesNotMatch(v, PAYMENT_SHAPED, `${v} looks payment-shaped`);
  assert.deepEqual(Object.keys(VERBS).sort(), [...VERB_NAMES].sort());
});

test('the verb table is frozen with a null prototype, and so is every entry', () => {
  assert.ok(Object.isFrozen(VERBS));
  assert.equal(Object.getPrototypeOf(VERBS), null);
  for (const v of VERB_NAMES) {
    assert.ok(Object.isFrozen(VERBS[v]), `${v} spec is frozen`);
    assert.ok(Object.isFrozen(VERBS[v].fields), `${v} fields are frozen`);
  }
});

test('a payment verb cannot be added to the table at runtime', () => {
  const payInvoice = { ...VERBS.PLACE_HOLD, verb: 'PAY_INVOICE' };
  const table = VERBS as unknown as Record<string, unknown>;
  assert.throws(() => { table.PAY_INVOICE = payInvoice; }, TypeError);
  assert.throws(() => Object.defineProperty(VERBS, 'PAY_INVOICE', { value: payInvoice }), TypeError);
  assert.throws(() => Object.setPrototypeOf(VERBS, { PAY_INVOICE: payInvoice }), TypeError);
  assert.throws(() => { delete table.PLACE_HOLD; }, TypeError);
  assert.throws(() => { (VERBS.PLACE_HOLD as unknown as Record<string, unknown>).apply = () => 'paid'; }, TypeError);
  assert.equal(isVerb('PAY_INVOICE'), false);
});

test('prototype pollution does not smuggle a verb in', () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  proto.PAY_SUPPLIER = { ...VERBS.PLACE_HOLD, verb: 'PAY_SUPPLIER', apply: () => 'paid' };
  try {
    assert.equal(isVerb('PAY_SUPPLIER'), false);
    const { executor, c, action, standing, store } = fixture();
    const a = action('PLACE_HOLD', { invoiceId: 'INV-1003', reasonCode: 'TEST' });
    (a as { verb: string }).verb = 'PAY_SUPPLIER';
    assert.throws(() => executor.execute(c, a, standing), ExecutionRefused);
    assert.equal(store.invoices.get('INV-1003')!.status, 'open');
  } finally {
    delete proto.PAY_SUPPLIER;
  }
});

test('the executor is sealed: no registration method, no writable fields', () => {
  const { executor } = fixture();
  assert.ok(Object.isFrozen(executor));
  const e = executor as unknown as Record<string, unknown>;
  for (const name of ['register', 'addVerb', 'use', 'extend', 'verbs', 'handlers']) assert.equal(e[name], undefined);
  assert.throws(() => { e.register = () => undefined; }, TypeError);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(executor)).sort(), ['constructor', 'execute']);
});

test('executing an unknown verb is refused and recorded', () => {
  const { executor, c, action, standing, audit } = fixture();
  const a = action('PLACE_HOLD', { invoiceId: 'INV-1003', reasonCode: 'TEST' });
  (a as { verb: string }).verb = 'PAY_INVOICE';
  assert.throws(() => executor.execute(c, a, standing), /not a kernel verb; the vocabulary is closed/);
  const last = audit.entries().at(-1)!;
  assert.equal(last.kind, 'REFUSAL');
  assert.match(last.summary, /PAY_INVOICE/);
});

test('every mutation needs a named person: agent, stranger and missing authorities are refused', () => {
  const { executor, c, action, store } = fixture();
  const a = action('REQUEST_CREDIT_MEMO', {
    invoiceId: 'INV-1003', to: 'ar@ironleaf-metals.example.com', amountUsd: 960, subject: 's', body: 'b',
  }, 960);
  a.status = 'approved';
  a.decidedBy = AGENT as never;
  assert.throws(() => executor.execute(c, a, { kind: 'human_approval', approver: AGENT as never, decidedAt: 'now' }), /not a human identity/);
  a.decidedBy = 'human:stranger@example.com';
  assert.throws(() => executor.execute(c, a, { kind: 'human_approval', approver: 'human:stranger@example.com', decidedAt: 'now' }), /not in the policy directory/);
  assert.throws(() => executor.execute(c, a, undefined as never), ExecutionRefused);
  assert.throws(() => executor.execute(c, a, {} as never), /no authority supplied/);
  assert.equal(store.outbox.length, 0);
});

test('a human approval must match the recorded decision and status', () => {
  const { executor, c, action } = fixture();
  const a = action('REQUEST_CREDIT_MEMO', {
    invoiceId: 'INV-1003', to: 'ar@ironleaf-metals.example.com', amountUsd: 960, subject: 's', body: 'b',
  }, 960);
  assert.throws(() => executor.execute(c, a, { kind: 'human_approval', approver: DANA, decidedAt: 'now' }), /not approved/);
  a.status = 'approved';
  a.decidedBy = PRIYA;
  assert.throws(() => executor.execute(c, a, { kind: 'human_approval', approver: DANA, decidedAt: 'now' }), /does not match the recorded decision/);
});

test('the standing approval only covers actions the signed policy marked autonomous', () => {
  const { executor, c, action, standing, policy } = fixture();
  const needsHuman = action('MARK_DUPLICATE', { invoiceId: 'INV-1003', duplicateOfInvoiceId: 'INV-1001' }, 17_440);
  assert.throws(() => executor.execute(c, needsHuman, standing), /only actions the policy marked autonomous/);
  const hold = action('PLACE_HOLD', { invoiceId: 'INV-1003', reasonCode: 'TEST' });
  assert.throws(() => executor.execute(c, hold, { ...standing, signedBy: DANA }), /does not match the signed policy/);
  assert.throws(() => executor.execute(c, hold, { ...standing, policyHash: '0'.repeat(64) }), /does not match the signed policy/);
  assert.equal(policy.signedBy, SAM);
});

test('a valid execution is logged under the authorizing person, and cannot run twice', () => {
  const { executor, c, action, standing, audit, store } = fixture();
  const hold = action('PLACE_HOLD', { invoiceId: 'INV-1003', reasonCode: 'PRICE_VARIANCE' });
  executor.execute(c, hold, standing);
  assert.equal(store.invoices.get('INV-1003')!.status, 'on_hold');
  const entry = audit.entries().at(-1)!;
  assert.equal(entry.kind, 'ACTION');
  assert.equal(entry.actor, SAM);
  assert.throws(() => executor.execute(c, hold, standing), /already executed/);
});

test('verb checks run again at execution time against current records', () => {
  const { executor, c, action, standing, store } = fixture();
  const other = action('PLACE_HOLD', { invoiceId: 'INV-1001', reasonCode: 'TEST' });
  assert.throws(() => executor.execute(c, other, standing), /not this case's invoice/);
  assert.equal(store.invoices.get('INV-1001')!.status, 'open');
});

test('the audit log itself refuses an ACTION entry without a human actor', () => {
  const audit = new AuditLog();
  assert.throws(() => audit.append('ACTION', AGENT as never, 'CASE-0001', 'sneaky'), AuditError);
  assert.throws(() => audit.append('HUMAN_DECISION', 'system:kernel', 'CASE-0001', 'sneaky'), AuditError);
});

test('through the kernel, an agent cannot approve and the refusal is audited', async () => {
  const { kernel, audit } = setup();
  const { InvoiceExceptionAgent } = await import('../agents/invoice-exception/agent.ts');
  await new InvoiceExceptionAgent(kernel).run();
  const pending = kernel.pending();
  assert.ok(pending.length > 0);
  const { caseRecord, action } = pending[0]!;
  const res = kernel.decide(caseRecord.id, action.id, AGENT, 'approve');
  assert.equal(res.ok, false);
  const last = audit.entries().at(-1)!;
  assert.equal(last.kind, 'REFUSAL');
  assert.equal(last.actor, AGENT);
  assert.equal(kernel.pending().length, pending.length, 'still waiting for a person');
});
