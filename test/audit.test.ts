import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuditError, AuditLog, GENESIS_HASH, hashEntry, verifyAuditFile, verifyChain } from '../kernel/audit.ts';
import type { AuditEntry } from '../kernel/audit.ts';
import { canonicalJson } from '../kernel/canonical.ts';
import { demoClock } from '../demo/run.ts';
import { AGENT, PRIYA, tempDir } from './helpers.ts';

function sampleLog(file?: string): AuditLog {
  const log = new AuditLog({ clock: demoClock(), ...(file ? { file } : {}) });
  log.append('SYSTEM', 'system:kernel', null, 'policy loaded', { version: '1' });
  log.append('READ', AGENT, 'CASE-0001', 'read invoice', { evidenceId: 'EV-0001' });
  log.append('PROPOSAL', AGENT, 'CASE-0001', 'proposal accepted', { actions: 1 });
  log.append('POLICY_DECISION', 'system:policy', 'CASE-0001', 'MARK_DUPLICATE -> needs_human', { amountAtStakeUsd: 58300 });
  log.append('HUMAN_DECISION', PRIYA, 'CASE-0001', 'APPROVED MARK_DUPLICATE', { decision: 'approve' });
  log.append('ACTION', PRIYA, 'CASE-0001', 'MARK_DUPLICATE executed', { amountAtStakeUsd: 58300 });
  return log;
}

const copy = (entries: readonly AuditEntry[]) => entries.map((e) => JSON.parse(JSON.stringify(e)) as AuditEntry);

test('a fresh chain verifies and links every entry to the one before it', () => {
  const log = sampleLog();
  const entries = log.entries();
  const r = verifyChain(entries);
  assert.equal(r.ok, true);
  assert.equal(r.count, 6);
  assert.equal(r.head, log.head());
  assert.equal(entries[0]!.prevHash, GENESIS_HASH);
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i]!.prevHash, entries[i - 1]!.hash);
});

test('editing any field of any entry is detected at that entry', () => {
  const entries = copy(sampleLog().entries());
  const edits: [number, (e: AuditEntry) => void][] = [
    [5, (e) => { e.actor = 'human:dana.ortiz@acme-fab.example.com'; }],
    [3, (e) => { (e.data as Record<string, number>).amountAtStakeUsd = 583; }],
    [1, (e) => { e.summary = 'read nothing'; }],
    [4, (e) => { e.at = '2026-01-01T00:00:00.000Z'; }],
  ];
  for (const [i, edit] of edits) {
    const tampered = copy(entries);
    edit(tampered[i]!);
    const r = verifyChain(tampered);
    assert.equal(r.ok, false);
    assert.equal(r.firstBadSeq, tampered[i]!.seq);
    assert.match(r.problem!, /does not match its hash/);
  }
});

test('re-hashing an edited entry does not help: the next entry no longer links to it', () => {
  const tampered = copy(sampleLog().entries());
  tampered[2]!.summary = 'proposal rejected';
  tampered[2]!.hash = hashEntry(tampered[2]!);
  const r = verifyChain(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, 4);
  assert.match(r.problem!, /prevHash/);
});

test('removing, inserting or reordering entries is detected', () => {
  const entries = copy(sampleLog().entries());
  const removed = entries.filter((_, i) => i !== 2);
  assert.equal(verifyChain(removed).firstBadSeq, 4);

  const swapped = copy(entries);
  [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
  assert.equal(verifyChain(swapped).ok, false);

  const inserted = copy(entries);
  inserted.splice(3, 0, { ...inserted[2]! });
  assert.equal(verifyChain(inserted).ok, false);
});

test('removing entries from the end is caught only against a recorded head', () => {
  const log = sampleLog();
  const truncated = copy(log.entries()).slice(0, 4);
  assert.equal(verifyChain(truncated).ok, true, 'a prefix of a valid chain is itself valid');
  const r = verifyChain(truncated, { expectedHead: log.head() });
  assert.equal(r.ok, false);
  assert.match(r.problem!, /does not match the expected head/);
});

test('a forged ACTION entry with an agent actor fails verification even with a correct hash', () => {
  const entries = copy(sampleLog().entries());
  const last = entries[5]!;
  last.actor = AGENT as never;
  last.hash = hashEntry(last);
  const r = verifyChain(entries);
  assert.equal(r.ok, false);
  assert.match(r.problem!, /non-human actor/);
});

test('file-backed logs persist, reopen, continue the chain, and verify from disk', () => {
  const file = join(tempDir(), 'audit.jsonl');
  const first = sampleLog(file);
  const reopened = new AuditLog({ file, clock: demoClock('2026-03-03T00:00:00.000Z') });
  assert.equal(reopened.head(), first.head());
  reopened.append('SYSTEM', 'system:kernel', null, 'second session');
  const r = verifyAuditFile(file);
  assert.equal(r.ok, true);
  assert.equal(r.count, 7);
});

test('a tampered file is reported by verify and refused for further appends', () => {
  const file = join(tempDir(), 'audit.jsonl');
  sampleLog(file);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const e = JSON.parse(lines[4]!);
  e.summary = 'REJECTED MARK_DUPLICATE';
  lines[4] = JSON.stringify(e);
  writeFileSync(file, lines.join('\n') + '\n');

  const r = verifyAuditFile(file);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, 5);
  assert.throws(() => new AuditLog({ file }), AuditError);
});

test('a line that is not JSON fails verification', () => {
  const file = join(tempDir(), 'audit.jsonl');
  sampleLog(file);
  writeFileSync(file, readFileSync(file, 'utf8') + '{not json\n');
  const r = verifyAuditFile(file);
  assert.equal(r.ok, false);
  assert.match(r.problem!, /not valid JSON/);
});

test('hashes are over canonical JSON, so key order does not matter', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  assert.throws(() => canonicalJson({ x: Number.POSITIVE_INFINITY }), /non-finite/);
});
