import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkApprover, decide, loadPolicy, PolicyError } from '../kernel/policy.ts';
import type { PolicyConfig } from '../kernel/policy.ts';
import { AGENT, DANA, LEO, PRIYA, SAM, policyConfig } from './helpers.ts';

const policy = loadPolicy(policyConfig());
const base = { confidence: 0.85, exceptionType: 'PRICE_VARIANCE' as const };

test('a protective zero-dollar verb inside the standing approval is autonomous', () => {
  const d = decide(policy, { ...base, verb: 'PLACE_HOLD', amountAtStakeUsd: 0 });
  assert.equal(d.outcome, 'autonomous');
  assert.match(d.reasons[0]!, /standing approval signed by human:sam\.whitfield/);
  assert.equal(d.policyHash, policy.hash);
});

test('monetary threshold: at the limit is autonomous, one cent over needs a person', () => {
  assert.equal(decide(policy, { ...base, verb: 'REQUEST_CREDIT_MEMO', amountAtStakeUsd: 250 }).outcome, 'autonomous');
  const over = decide(policy, { ...base, verb: 'REQUEST_CREDIT_MEMO', amountAtStakeUsd: 250.01 });
  assert.equal(over.outcome, 'needs_human');
  assert.match(over.reasons.join(' '), /exceeds the standing limit of \$250\.00/);
});

test('confidence gate: below the floor every verb needs a person, even a hold', () => {
  const d = decide(policy, { ...base, verb: 'PLACE_HOLD', amountAtStakeUsd: 0, confidence: 0.6 });
  assert.equal(d.outcome, 'needs_human');
  assert.match(d.reasons.join(' '), /below the floor of 0\.80/);
});

test('verbs configured with no autonomous limit always need a person', () => {
  assert.equal(decide(policy, { ...base, verb: 'MARK_DUPLICATE', amountAtStakeUsd: 1 }).outcome, 'needs_human');
  assert.equal(decide(policy, { ...base, verb: 'RELEASE_HOLD', amountAtStakeUsd: 0 }).outcome, 'needs_human');
});

test('unknown and disabled verbs are blocked', () => {
  assert.equal(decide(policy, { ...base, verb: 'PAY_INVOICE', amountAtStakeUsd: 10 }).outcome, 'blocked');
  const off = loadPolicy({ ...policyConfig(), verbs: { ...policyConfig().verbs, CREATE_TASK: { enabled: false, autonomousUpToUsd: 0 } } });
  assert.equal(decide(off, { ...base, verb: 'CREATE_TASK', amountAtStakeUsd: 0 }).outcome, 'blocked');
});

test('an unsigned policy grants no standing approval: everything needs a person', () => {
  const unsigned = loadPolicy({ ...policyConfig(), signedBy: null, signedAt: null });
  const d = decide(unsigned, { ...base, verb: 'PLACE_HOLD', amountAtStakeUsd: 0 });
  assert.equal(d.outcome, 'needs_human');
  assert.match(d.reasons.join(' '), /unsigned/);
});

test('approval matrix: the band sets eligible roles, and exception minimums narrow them', () => {
  assert.deepEqual(decide(policy, { ...base, verb: 'REQUEST_CREDIT_MEMO', amountAtStakeUsd: 960 }).eligibleRoles, ['ap_lead', 'controller', 'cfo']);
  assert.deepEqual(decide(policy, { ...base, verb: 'REQUEST_CREDIT_MEMO', amountAtStakeUsd: 12_000 }).eligibleRoles, ['controller', 'cfo']);
  assert.deepEqual(decide(policy, { ...base, verb: 'MARK_DUPLICATE', amountAtStakeUsd: 58_300 }).eligibleRoles, ['cfo']);
  assert.deepEqual(
    decide(policy, { ...base, exceptionType: 'MISSING_PO', verb: 'REQUEST_RETRO_PO', amountAtStakeUsd: 2_450 }).eligibleRoles,
    ['controller', 'cfo'],
  );
});

test('checkApprover enforces segregation of duties, the directory and the matrix', () => {
  const big = decide(policy, { ...base, verb: 'MARK_DUPLICATE', amountAtStakeUsd: 58_300 });
  const agent = checkApprover(policy, big, AGENT);
  assert.equal(agent.ok, false);
  assert.match(!agent.ok ? agent.reason : '', /segregation of duties/);
  assert.equal(checkApprover(policy, big, 'human:stranger@example.com').ok, false);
  assert.equal(checkApprover(policy, big, 'dana').ok, false);
  const dana = checkApprover(policy, big, DANA);
  assert.match(!dana.ok ? dana.reason : '', /requires one of: cfo/);
  assert.equal(checkApprover(policy, big, LEO).ok, false, 'a buyer in the directory still lacks an approving role');
  assert.equal(checkApprover(policy, big, PRIYA).ok, true);
  const auto = decide(policy, { ...base, verb: 'PLACE_HOLD', amountAtStakeUsd: 0 });
  assert.equal(checkApprover(policy, auto, SAM).ok, false, 'nothing to approve on an autonomous decision');
});

test('loadPolicy rejects a payment verb: configuration cannot extend the vocabulary', () => {
  const cfg = policyConfig();
  (cfg.verbs as Record<string, unknown>).PAY_INVOICE = { enabled: true, autonomousUpToUsd: 1_000_000 };
  assert.throws(() => loadPolicy(cfg), (e: unknown) => e instanceof PolicyError && /PAY_INVOICE is not in the kernel vocabulary/.test(e.message));
});

test('loadPolicy rejects making a kernel human-only verb autonomous', () => {
  const cfg = policyConfig();
  cfg.verbs.RELEASE_HOLD = { enabled: true, autonomousUpToUsd: 100 };
  assert.throws(() => loadPolicy(cfg), /RELEASE_HOLD is human-only by kernel rule/);
});

test('loadPolicy rejects a signer who is not a person in the directory', () => {
  assert.throws(() => loadPolicy({ ...policyConfig(), signedBy: 'agent:invoice-exception' } as unknown as PolicyConfig), /signedBy must be a human identity/);
  assert.throws(() => loadPolicy({ ...policyConfig(), signedBy: 'human:someone@example.com' }), /not in the directory/);
});

test('loadPolicy rejects a malformed approval matrix', () => {
  const cfg = policyConfig();
  cfg.approvalMatrix.bands = [{ upToUsd: 5000, roles: ['ap_lead'] }];
  assert.throws(() => loadPolicy(cfg), /last band must be unbounded/);
});

test('the policy is frozen and fingerprinted; any change produces a different hash', () => {
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.verbs));
  assert.throws(() => { (policy.verbs as Record<string, unknown>).REQUEST_CREDIT_MEMO = { enabled: true, autonomousUpToUsd: 1e9 }; }, TypeError);
  const cfg = policyConfig();
  cfg.verbs.REQUEST_CREDIT_MEMO = { enabled: true, autonomousUpToUsd: 251 };
  assert.notEqual(loadPolicy(cfg).hash, policy.hash);
  assert.equal(loadPolicy(policyConfig()).hash, policy.hash, 'same content, same hash');
});
