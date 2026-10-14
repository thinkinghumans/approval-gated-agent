import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readAuditFile, verifyAuditFile } from '../kernel/audit.ts';
import { isHumanId } from '../kernel/identity.ts';
import { runDemo } from '../demo/run.ts';
import { tempDir } from './helpers.ts';

const quiet = () => undefined;

test('end to end: ingest, screen, propose, decide, approve/reject, execute, verify', async () => {
  const outDir = tempDir('aga-demo-');
  const lines: string[] = [];
  const r = await runDemo({ outDir, log: (l) => lines.push(l) });

  // Screening and cases
  assert.equal(r.summary.screened, 8);
  assert.deepEqual(r.summary.clean.sort(), ['INV-1001', 'INV-1004', 'INV-1006', 'INV-1008']);
  const states = Object.fromEntries(r.cases.map((c) => [c.invoiceId, c.state]));
  assert.deepEqual(states, {
    'INV-1002': 'actions_executed', // all within the standing approval
    'INV-1003': 'actions_executed', // AP lead approved the $960 credit memo request
    'INV-1005': 'needs_follow_up',  // controller rejected the retro-PO request
    'INV-1007': 'actions_executed', // CFO approved rejecting the $58,300 duplicate
  });

  // Business outcome
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  const status = Object.fromEntries(state.invoices.map((i: { id: string; status: string }) => [i.id, i.status]));
  assert.equal(status['INV-1007'], 'rejected_duplicate');
  assert.equal(status['INV-1004'], 'open', 'the original is untouched');
  for (const id of ['INV-1002', 'INV-1003', 'INV-1005']) assert.equal(status[id], 'on_hold');
  assert.equal(state.outbox.length, 2);
  assert.ok(state.outbox.every((d: { status: string }) => d.status === 'draft'), 'nothing is sent');
  assert.deepEqual(state.outbox.map((d: { amountUsd: number }) => d.amountUsd), [170, 960]);
  assert.equal(state.tasks.length, 2);

  // Who decided what
  const dup = r.cases.find((c) => c.invoiceId === 'INV-1007')!.actions.find((a) => a.verb === 'MARK_DUPLICATE')!;
  assert.equal(dup.decidedBy, 'human:priya.raman@acme-fab.example.com');
  const retro = r.cases.find((c) => c.invoiceId === 'INV-1005')!.actions.find((a) => a.verb === 'REQUEST_RETRO_PO')!;
  assert.equal(retro.status, 'rejected');
  assert.match(retro.rejectionReason!, /blanket freight PO/);

  // Audit log
  const { entries } = readAuditFile(r.auditFile);
  const actions = entries.filter((e) => e.kind === 'ACTION');
  const executed = r.cases.flatMap((c) => c.actions).filter((a) => a.status === 'executed');
  assert.equal(actions.length, executed.length);
  assert.ok(actions.every((e) => isHumanId(e.actor)), 'every executed action names a person');
  const refusals = entries.filter((e) => e.kind === 'REFUSAL').map((e) => e.summary);
  assert.ok(refusals.some((s) => /agent:invoice-exception refused: segregation of duties/.test(s)));
  assert.ok(refusals.some((s) => /Dana Ortiz \(ap_lead\) is not authorized for \$58,300\.00/.test(s)));
  const kinds = new Set(entries.map((e) => e.kind));
  for (const k of ['SYSTEM', 'READ', 'INFERENCE', 'PROPOSAL', 'POLICY_DECISION', 'HUMAN_DECISION', 'ACTION', 'REFUSAL']) assert.ok(kinds.has(k as never), `log has ${k}`);

  // Verification, tamper and truncation checks
  assert.equal(r.verify.ok, true);
  assert.equal(r.tamperCheck.ok, false);
  assert.ok(r.tamperCheck.firstBadSeq !== null);
  assert.equal(r.truncationCheck.ok, false);
  assert.equal(verifyAuditFile(r.auditFile, { expectedHead: r.head }).ok, true);

  assert.ok(lines.some((l) => /Payments made: 0\. There is no payment verb\./.test(l)));
});

test('the demo is deterministic: same data and decisions produce the same head hash', async () => {
  const a = await runDemo({ outDir: tempDir(), log: quiet });
  const b = await runDemo({ outDir: tempDir(), log: quiet });
  assert.equal(a.head, b.head);
});

test('running again archives the previous log instead of overwriting it', async () => {
  const outDir = tempDir();
  await runDemo({ outDir, log: quiet });
  const second = await runDemo({ outDir, log: quiet });
  assert.equal(second.verify.ok, true);
  const archived = readdirSync(join(outDir, 'archive'));
  assert.equal(archived.length, 1);
  assert.equal(verifyAuditFile(join(outDir, 'archive', archived[0]!)).ok, true);
});

test('interactive review: refusals are explained and the person can choose again', async () => {
  // Pending order: ACT-0005 credit memo ($960), ACT-0007 retro PO ($2,450), ACT-0010 duplicate ($58,300).
  // Directory order: 1 Dana (ap_lead), 2 Sam (controller), 3 Priya (cfo), 4 Leo (buyer), 5 Mae (receiving), 6 the agent.
  const answers = [
    'a', '1',                      // Dana approves the $960 credit memo request
    'r', '2', 'Covered by blanket freight PO', // Sam rejects the retro-PO request
    'a', '6',                      // the agent tries to approve: refused
    'a', '1',                      // Dana tries $58,300: refused
    'a', '3',                      // Priya approves
  ];
  const lines: string[] = [];
  const r = await runDemo({
    outDir: tempDir(), interactive: true, log: (l) => lines.push(l),
    ask: async () => answers.shift() ?? 's',
  });
  assert.equal(answers.length, 0, 'every scripted answer was consumed');
  assert.ok(lines.some((l) => /REFUSED: segregation of duties/.test(l)));
  assert.ok(lines.some((l) => /REFUSED: Dana Ortiz \(ap_lead\) is not authorized/.test(l)));
  const states = Object.fromEntries(r.cases.map((c) => [c.invoiceId, c.state]));
  assert.equal(states['INV-1007'], 'actions_executed');
  assert.equal(states['INV-1005'], 'needs_follow_up');
  assert.equal(r.verify.ok, true);
  assert.ok(existsSync(r.auditFile));
});
