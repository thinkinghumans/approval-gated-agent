import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvoiceExceptionAgent } from '../agents/invoice-exception/agent.ts';
import { buildProposal } from '../agents/invoice-exception/playbooks.ts';
import { normalizeInvoiceNo, screenAll } from '../agents/invoice-exception/screen.ts';
import type { Planner, PlanningInput } from '../agents/planner.ts';
import { validateProposal, wireAction } from '../kernel/proposal.ts';
import type { WireProposal } from '../kernel/proposal.ts';
import { Store } from '../kernel/store.ts';
import type { Case } from '../kernel/types.ts';
import { AGENT, dataset, setup } from './helpers.ts';

function scripted(id: string, fn: (input: PlanningInput) => unknown): Planner & { inputs: PlanningInput[] } {
  const inputs: PlanningInput[] = [];
  return { id, inputs, plan: async (input) => (inputs.push(input), { raw: fn(input) }) };
}

/** Start from the playbook's proposal for the case and change one thing. */
function tweak(edit: (p: WireProposal, input: PlanningInput) => void) {
  return (input: PlanningInput) => {
    const p = buildProposal(input);
    edit(p, input);
    return p;
  };
}

async function runWith(planner: Planner, fallback: Planner | null = null) {
  const env = setup();
  const summary = await new InvoiceExceptionAgent(env.kernel, planner, { fallback }).run();
  const byInvoice = (id: string) => env.kernel.cases().find((c) => c.invoiceId === id)!;
  return { ...env, summary, byInvoice };
}

test('screening finds exactly the planted exceptions, with dollar amounts', () => {
  const { kernel } = setup();
  const results = screenAll(kernel.readForScreening(AGENT), kernel.policy.screening);
  const found = Object.fromEntries(results.filter((r) => r.findings.length).map((r) => [r.invoiceId, r.findings.map((f) => [f.type, f.amountAtStakeUsd])]));
  assert.deepEqual(found, {
    'INV-1002': [['QTY_VARIANCE', 170]],
    'INV-1003': [['PRICE_VARIANCE', 960]],
    'INV-1005': [['MISSING_PO', 2450]],
    'INV-1007': [['DUPLICATE_INVOICE', 58300]],
  });
  assert.deepEqual(results.filter((r) => !r.findings.length).map((r) => r.invoiceId).sort(), ['INV-1001', 'INV-1004', 'INV-1006', 'INV-1008']);
});

test('price tolerance is respected: 1% over the PO price is not a variance', () => {
  const ds = dataset();
  const inv = ds.invoices.find((i) => i.id === 'INV-1003')!;
  inv.lines[0]!.unitPriceUsd = 416.12; // exactly +1.0%
  inv.totalUsd = 16644.8;
  const store = Store.fromDataset(ds);
  const view = { suppliers: [...store.suppliers.values()], purchaseOrders: [...store.purchaseOrders.values()], receipts: [...store.receipts.values()], invoices: [...store.invoices.values()] };
  const r = screenAll(view, { priceTolerancePct: 1, qtyTolerancePct: 0 }).find((x) => x.invoiceId === 'INV-1003')!;
  assert.deepEqual(r.findings, []);
});

test('invoice number normalization catches re-sent copies but not different numbers', () => {
  assert.equal(normalizeInvoiceNo('TC-20931-R'), normalizeInvoiceNo('TC-20931'));
  assert.equal(normalizeInvoiceNo('tc 20931 (copy)'), normalizeInvoiceNo('TC-20931'));
  assert.equal(normalizeInvoiceNo('TC-20931-REV2'), 'TC20931');
  assert.notEqual(normalizeInvoiceNo('TC-20931'), normalizeInvoiceNo('TC-20932'));
  assert.notEqual(normalizeInvoiceNo('4471R'), normalizeInvoiceNo('4471'));
});

test('agents receive copies: changing what they read changes nothing in the store', () => {
  const { kernel } = setup();
  const view = kernel.readForScreening(AGENT);
  view.invoices[0]!.status = 'rejected_duplicate';
  view.invoices[0]!.totalUsd = 0;
  const snap = kernel.snapshot() as { invoices: { id: string; status: string; totalUsd: number }[] };
  assert.equal(snap.invoices[0]!.status, 'open');
  assert.equal(snap.invoices[0]!.totalUsd, 14670);
});

test('the playbook proposes the standard response for each exception type', async () => {
  const { byInvoice, summary } = await runWith(scripted('playbook-probe', buildProposal));
  assert.equal(summary.cases.length, 4);
  const verbs = (c: Case) => c.actions.map((a) => a.verb);
  assert.deepEqual(verbs(byInvoice('INV-1002')), ['PLACE_HOLD', 'REQUEST_CREDIT_MEMO', 'CREATE_TASK']);
  assert.deepEqual(verbs(byInvoice('INV-1003')), ['PLACE_HOLD', 'REQUEST_CREDIT_MEMO']);
  assert.deepEqual(verbs(byInvoice('INV-1005')), ['PLACE_HOLD', 'REQUEST_RETRO_PO', 'CREATE_TASK']);
  assert.deepEqual(verbs(byInvoice('INV-1007')), ['PLACE_HOLD', 'MARK_DUPLICATE']);
});

test('supplier memo text is untrusted: it is fenced for planners and triggers out-of-band verification, nothing else', async () => {
  const probe = scripted('playbook-probe', buildProposal);
  const { byInvoice, kernel } = await runWith(probe);
  const input = probe.inputs.find((i) => i.invoiceId === 'INV-1005')!;
  assert.equal(input.untrustedText.length, 1);
  assert.match(input.untrustedText[0]!.text, /remittance/);
  const verify = byInvoice('INV-1005').actions.find((a) => a.verb === 'CREATE_TASK')!;
  assert.match(String(verify.params.title), /Verify remittance-change request/);
  assert.equal(verify.params.assignee, 'human:sam.whitfield@acme-fab.example.com');
  const snap = kernel.snapshot() as { invoices: { id: string; status: string }[] };
  assert.equal(snap.invoices.find((i) => i.id === 'INV-1005')!.status, 'on_hold', 'held, not released');
});

test('the kernel prices actions itself; a planner cannot understate the amount at stake', async () => {
  const { byInvoice } = await runWith(scripted('lowballer', tweak((p) => {
    for (const a of p.actions) (a as Record<string, unknown>).amountAtStakeUsd = 1; // ignored field
  })));
  const dup = byInvoice('INV-1007').actions.find((a) => a.verb === 'MARK_DUPLICATE')!;
  assert.equal(dup.amountAtStakeUsd, 58_300);
  assert.equal(dup.status, 'awaiting_human');
  assert.deepEqual(dup.decision.eligibleRoles, ['cfo']);
});

const rejections: [string, (p: WireProposal, input: PlanningInput) => void, RegExp][] = [
  ['an invented payment verb', (p, i) => { p.actions.push({ ...wireAction('PLACE_HOLD', 'pay it', { invoiceId: i.invoiceId }), verb: 'PAY_INVOICE' }); }, /PAY_INVOICE.*not in the kernel vocabulary/],
  ['a fabricated citation', (p) => { p.citations.push('EV-9999'); }, /EV-9999 is not evidence recorded/],
  ['a draft to an address that is not the supplier master contact', (p, i) => {
    p.actions.push(wireAction('DRAFT_SUPPLIER_EMAIL', 'per memo', { invoiceId: i.invoiceId, to: 'payments@attacker.example.com', subject: 's', body: 'b' }));
  }, /not the AP contact on the supplier master/],
  ['an action on a different invoice', (p) => { p.actions[0]!.invoiceId = 'INV-1001'; }, /not this case's invoice/],
  ['a task for someone outside the directory', (p, i) => {
    p.actions.push(wireAction('CREATE_TASK', 'x', { invoiceId: i.invoiceId, assignee: 'human:outsider@example.com', title: 't', body: 'b' }));
  }, /not a person in the policy directory/],
  ['a credit memo larger than the invoice', (p, i) => {
    p.actions.push(wireAction('REQUEST_CREDIT_MEMO', 'x', { invoiceId: i.invoiceId, to: i.supplier.apEmail, amountUsd: 1e7, subject: 's', body: 'b' }));
  }, /exceeds the invoice total/],
  ['a missing required parameter', (p) => { p.actions[0]!.reasonCode = null; }, /PLACE_HOLD requires reasonCode/],
  ['an unknown classification', (p) => { p.classification = 'FRAUD'; }, /classification must be one of/],
];

for (const [label, edit, expected] of rejections) {
  test(`the kernel rejects a proposal with ${label}; with no fallback the case escalates untouched`, async () => {
    const { kernel, audit } = await runWith(scripted('test:bad', tweak(edit)), null);
    const rejected = audit.entries().filter((e) => e.kind === 'PROPOSAL' && /rejected/.test(e.summary));
    assert.equal(rejected.length, 4, 'one rejected PROPOSAL entry per case');
    assert.ok(rejected.every((e) => expected.test(JSON.stringify(e.data))), `rejection reason matches ${expected}`);
    for (const c of kernel.cases()) {
      assert.equal(c.state, 'escalated');
      assert.equal(c.actions.length, 0);
    }
    assert.equal(audit.entries().filter((e) => e.kind === 'ACTION').length, 0, 'nothing executed');
  });
}

test('a planner that throws is recorded, and the playbook fallback produces the proposal', async () => {
  const failing: Planner = { id: 'test:offline', plan: async () => { throw new Error('connection refused'); } };
  const env = setup();
  await new InvoiceExceptionAgent(env.kernel, failing).run();
  const cases = env.kernel.cases();
  assert.ok(cases.every((c) => c.plannedBy === 'playbook:invoice-exception@1'));
  const failures = env.audit.entries().filter((e) => e.kind === 'INFERENCE' && /test:offline failed: connection refused/.test(e.summary));
  assert.equal(failures.length, cases.length);
});

test('an invalid model proposal falls back to the playbook for that case', async () => {
  const env = setup();
  const bad = scripted('test:model', tweak((p) => { p.citations = ['EV-0404']; }));
  await new InvoiceExceptionAgent(env.kernel, bad).run();
  for (const c of env.kernel.cases()) {
    assert.equal(c.plannedBy, 'playbook:invoice-exception@1');
    assert.ok(c.actions.length > 0);
  }
});

test('thin evidence caps confidence at medium, whatever the planner claims', () => {
  const store = Store.fromDataset(dataset());
  const c: Case = {
    id: 'CASE-X', invoiceId: 'INV-1003', supplierId: 'SUP-IRONLEAF', primaryType: 'PRICE_VARIANCE', findings: [],
    evidence: [{ id: 'EV-1', source: 'invoices', ref: 'INV-1003', summary: '', snapshot: null, sha256: '' }],
    state: 'detected', proposal: null, plannedBy: null, actions: [], escalationReason: null, openedAt: '',
  };
  const raw: WireProposal = {
    classification: 'PRICE_VARIANCE', diagnosis: 'x [EV-1]', confidence: 'certain', citations: ['EV-1'],
    actions: [wireAction('PLACE_HOLD', 'hold', { invoiceId: 'INV-1003', reasonCode: 'PRICE_VARIANCE' })],
  };
  const r = validateProposal(raw, { store, caseRecord: c, directory: {} }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.proposal.confidence, 0.6);
});
