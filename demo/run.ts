import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { AuditLog, verifyAuditFile } from '../kernel/audit.ts';
import type { VerifyResult } from '../kernel/audit.ts';
import { digest } from '../kernel/canonical.ts';
import { Kernel } from '../kernel/kernel.ts';
import { loadPolicy } from '../kernel/policy.ts';
import { Store } from '../kernel/store.ts';
import type { Case, Dataset } from '../kernel/types.ts';
import { usd } from '../kernel/money.ts';
import { InvoiceExceptionAgent } from '../agents/invoice-exception/agent.ts';
import type { AgentRunSummary } from '../agents/invoice-exception/agent.ts';
import { PlaybookPlanner } from '../agents/invoice-exception/playbooks.ts';
import type { Planner } from '../agents/planner.ts';

// The end-to-end walkthrough:
//   ingest -> screen -> propose -> policy decision -> human approve/reject
//   -> execute -> audit verify (plus a tamper check on a copy of the log)

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATASET_FILE = join(HERE, 'data', 'acme-fabrication.json');
export const POLICY_FILE = join(HERE, 'policy.json');
export const DECISIONS_FILE = join(HERE, 'decisions.json');

export interface ScriptedDecision {
  invoiceId: string;
  verb: string;
  by: string;
  decision: 'approve' | 'reject';
  reason?: string;
  note?: string;
}

export interface DemoOptions {
  outDir: string;
  planner?: Planner;
  interactive?: boolean;
  decisions?: ScriptedDecision[];
  log?: (line: string) => void;
  /** Use wall-clock time instead of the deterministic demo clock. */
  realClock?: boolean;
  /** Prompt function for interactive review. Defaults to a terminal prompt on stdin/stdout. */
  ask?: (question: string) => Promise<string>;
}

export interface DemoResult {
  auditFile: string;
  stateFile: string;
  head: string;
  summary: AgentRunSummary;
  cases: Case[];
  verify: VerifyResult;
  tamperCheck: VerifyResult;
  truncationCheck: VerifyResult;
}

/** Deterministic clock: one second per reading, from a fixed start. Same data in, same hashes out. */
export function demoClock(start = '2026-03-02T14:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.realClock ? () => new Date() : demoClock();
  const planner = opts.planner ?? new PlaybookPlanner();
  mkdirSync(opts.outDir, { recursive: true });
  const auditFile = join(opts.outDir, 'audit.jsonl');
  const stateFile = join(opts.outDir, 'state.json');
  archivePrevious(auditFile);

  const step = (n: number, title: string) => log(`\n[${n}/7] ${title}\n${'-'.repeat(title.length + 6)}`);

  // 1. Ingest -----------------------------------------------------------------
  step(1, 'Ingest');
  const dataset = JSON.parse(readFileSync(DATASET_FILE, 'utf8')) as Dataset;
  const policy = loadPolicy(JSON.parse(readFileSync(POLICY_FILE, 'utf8')));
  const store = Store.fromDataset(dataset);
  const audit = new AuditLog({ file: auditFile, clock });
  audit.append('SYSTEM', 'system:ingest', null, `Ingested ${dataset.company.name}: ${dataset.invoices.length} invoices, ${dataset.purchaseOrders.length} POs, ${dataset.receipts.length} receipts, ${dataset.suppliers.length} suppliers`, {
    datasetSha256: digest(dataset),
  });
  const kernel = new Kernel({ store, audit, policy, clock });
  log(`${dataset.company.name}: ${dataset.invoices.length} supplier invoices, ${dataset.purchaseOrders.length} purchase orders, ${dataset.receipts.length} goods receipts.`);
  log(`Policy ${policy.version} (sha256 ${policy.hash.slice(0, 12)}...) signed by ${policy.signedBy ?? 'nobody'}.`);
  log(`Planner: ${planner.id}${planner.id.startsWith('playbook') ? ' (deterministic, offline)' : ' (model; playbook is the fallback)'}`);

  // 2-4. Screen, propose, decide (the agent does all three in one pass) --------
  const agent = new InvoiceExceptionAgent(kernel, planner);
  const summary = await agent.run();
  const byInvoice = new Map(kernel.cases().map((c) => [c.invoiceId, c]));

  step(2, 'Screen');
  for (const inv of [...store.invoices.values()]) {
    const c = byInvoice.get(inv.id);
    if (!c) log(`  ${inv.id}  ${pad(inv.supplierInvoiceNo, 11)} ${pad(usd(inv.totalUsd), 11, true)}  clean: matches PO and receipts`);
    else for (const f of c.findings) log(`  ${inv.id}  ${pad(inv.supplierInvoiceNo, 11)} ${pad(usd(inv.totalUsd), 11, true)}  ${f.type}: ${f.detail}`);
  }
  log(`${summary.clean.length} clean, ${summary.cases.length} exceptions -> ${summary.cases.map((c) => c.caseId).join(', ')}`);

  step(3, 'Propose');
  for (const c of kernel.cases()) {
    log(`  ${c.id} ${c.primaryType} on ${c.invoiceId}`);
    log(`    evidence: ${c.evidence.map((e) => e.id).join(', ')}`);
    if (!c.proposal) {
      log(`    no accepted proposal; escalated: ${c.escalationReason}`);
      continue;
    }
    log(`    planned by ${c.plannedBy}, confidence ${c.proposal.confidenceBand}`);
    log(wrap(`diagnosis: ${c.proposal.diagnosis}`, '    '));
    for (const a of c.actions) log(`    - ${a.id} ${a.verb}: ${a.rationale}`);
  }

  step(4, 'Policy decision');
  log('  Each action is priced by the kernel and decided by policy. Standing approvals execute now.');
  for (const c of kernel.cases()) {
    for (const a of c.actions) {
      const tail = a.decision.outcome === 'needs_human' ? `needs ${a.decision.eligibleRoles.join(' / ')}` : a.decision.outcome;
      log(`  ${c.id} ${a.id} ${pad(a.verb, 21)} ${pad(usd(a.amountAtStakeUsd), 11, true)}  -> ${tail}`);
      if (a.decision.outcome === 'needs_human') for (const r of a.decision.reasons) log(`        because ${r}`);
      if (a.status === 'executed') log(`        executed under standing approval: ${a.result}`);
    }
  }

  // 5-6. Human review and execution ---------------------------------------------
  step(5, opts.interactive ? 'Human review (interactive)' : 'Human review (scripted)');
  if (opts.interactive) await reviewInteractively(kernel, log, opts.ask);
  else reviewScripted(kernel, opts.decisions ?? loadDecisions(), log);

  step(6, 'Outcome');
  const cases = kernel.cases();
  for (const c of cases) {
    log(`  ${c.id} ${pad(c.primaryType, 17)} ${c.invoiceId}  state: ${c.state}`);
    for (const a of c.actions) {
      const who = a.decidedBy ?? (a.status === 'executed' ? `standing approval (${policy.signedBy})` : '');
      log(`    ${a.id} ${pad(a.verb, 21)} ${pad(a.status, 15)} ${who}`);
    }
  }
  const snap = kernel.snapshot() as { invoices: { id: string; status: string; holdReason: string | null }[]; outbox: unknown[]; tasks: unknown[] };
  log(`  Invoices: ${snap.invoices.map((i) => `${i.id}=${i.status}`).join(', ')}`);
  log(`  Outbox: ${snap.outbox.length} draft(s), none sent. Tasks: ${snap.tasks.length} open.`);
  log('  Payments made: 0. There is no payment verb.');
  writeFileSync(stateFile, JSON.stringify(snap, null, 2) + '\n');

  // 7. Audit verification -------------------------------------------------------
  step(7, 'Audit verification');
  const verify = verifyAuditFile(auditFile);
  log(`  ${auditFile}: ${verify.count} entries, chain ${verify.ok ? 'intact' : `BROKEN at seq ${verify.firstBadSeq}: ${verify.problem}`}`);
  log(`  Head hash: ${verify.head}`);
  log('  Keep the head hash outside this system (close binder, ticket). Verifying against it later also detects entries removed from the end.');

  const tamperFile = join(opts.outDir, 'audit.tampered.jsonl');
  const tampered = tamperCopy(auditFile, tamperFile);
  const tamperCheck = verifyAuditFile(tamperFile);
  log(`  Tamper check: on a copy, ${tampered.what} (seq ${tampered.seq}) -> ${tamperCheck.ok ? 'NOT DETECTED' : `detected at seq ${tamperCheck.firstBadSeq}: ${tamperCheck.problem}`}`);

  const truncFile = join(opts.outDir, 'audit.truncated.jsonl');
  truncateCopy(auditFile, truncFile, 3);
  const truncationCheck = verifyAuditFile(truncFile, { expectedHead: verify.head });
  log(`  Truncation check: dropped the last 3 entries -> ${truncationCheck.ok ? 'NOT DETECTED' : `detected with the recorded head (${truncationCheck.problem})`}`);
  log(`\nFiles: ${auditFile}, ${stateFile}`);
  log(`Verify any time:  npm run verify -- ${auditFile} --head ${verify.head}`);

  return { auditFile, stateFile, head: verify.head, summary, cases, verify, tamperCheck, truncationCheck };
}

function reviewScripted(kernel: Kernel, script: ScriptedDecision[], log: (l: string) => void): void {
  for (const d of script) {
    const pending = kernel.pending().find((p) => p.caseRecord.invoiceId === d.invoiceId && p.action.verb === d.verb);
    if (!pending) {
      log(`  (skipped: no pending ${d.verb} on ${d.invoiceId})`);
      continue;
    }
    const { caseRecord: c, action: a } = pending;
    if (d.note) log(`  ${d.note}`);
    const res = kernel.decide(c.id, a.id, d.by, d.decision, d.reason ?? '');
    if (res.ok) {
      log(`    ${d.by} ${d.decision === 'approve' ? 'APPROVED' : 'REJECTED'} ${a.id} ${a.verb} ${usd(a.amountAtStakeUsd)}${d.reason ? ` ("${d.reason}")` : ''}`);
      if (res.action.result) log(`    executed: ${res.action.result}`);
    } else {
      log(`    REFUSED for ${d.by}: ${res.reason}`);
    }
  }
  const left = kernel.pending();
  if (left.length) log(`  ${left.length} action(s) still waiting for a person: ${left.map((p) => `${p.action.id} ${p.action.verb}`).join(', ')}`);
}

async function reviewInteractively(kernel: Kernel, log: (l: string) => void, ask?: (q: string) => Promise<string>): Promise<void> {
  const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const question = ask ?? ((q: string) => rl!.question(q));
  const people = Object.entries(kernel.policy.directory);
  try {
    for (const { caseRecord: c, action: a } of kernel.pending()) {
      log(`\n  ${c.id} ${c.primaryType} on ${c.invoiceId}`);
      log(wrap(`diagnosis: ${c.proposal?.diagnosis ?? ''}`, '    '));
      log(`    ${a.id} ${a.verb} ${usd(a.amountAtStakeUsd)}: ${a.rationale}`);
      for (const [k, v] of Object.entries(a.params)) log(wrap(`${k}: ${String(v)}`, '      '));
      log(`    eligible approvers: ${a.decision.eligibleRoles.join(', ')}`);
      for (;;) {
        const choice = (await question('    [a]pprove, [r]eject or [s]kip? ')).trim().toLowerCase();
        if (choice === 's' || choice === '') break;
        if (choice !== 'a' && choice !== 'r') continue;
        people.forEach(([id, p], i) => log(`      ${i + 1}) ${p.name} (${p.role})  ${id}`));
        log(`      ${people.length + 1}) agent:invoice-exception`);
        const n = Number((await question('    as who? ')).trim());
        const identity = n === people.length + 1 ? 'agent:invoice-exception' : people[n - 1]?.[0];
        if (!identity) continue;
        const reason = choice === 'r' ? (await question('    reason: ')).trim() : '';
        const res = kernel.decide(c.id, a.id, identity, choice === 'a' ? 'approve' : 'reject', reason);
        if (res.ok) {
          log(`    recorded: ${res.action.status}${res.action.result ? ` (${res.action.result})` : ''}`);
          break;
        }
        log(`    REFUSED: ${res.reason}`);
      }
    }
  } finally {
    rl?.close();
  }
}

export function loadDecisions(): ScriptedDecision[] {
  return JSON.parse(readFileSync(DECISIONS_FILE, 'utf8')) as ScriptedDecision[];
}

function archivePrevious(auditFile: string): void {
  if (!existsSync(auditFile)) return;
  // An audit log is never deleted, even between demo runs.
  const dir = join(dirname(auditFile), 'archive');
  mkdirSync(dir, { recursive: true });
  renameSync(auditFile, join(dir, `audit-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
}

/**
 * Copy the log and edit one entry the way someone covering their tracks might:
 * swap the approver on the duplicate-invoice approval (or, failing that, edit
 * the summary of an entry in the middle).
 */
function tamperCopy(src: string, dest: string): { seq: number; what: string } {
  copyFileSync(src, dest);
  const lines = readFileSync(dest, 'utf8').trimEnd().split('\n');
  const entries = lines.map((l) => JSON.parse(l) as { seq: number; kind: string; actor: string; summary: string; data: { verb?: string; decision?: string } });
  let idx = entries.findIndex((e) => e.kind === 'HUMAN_DECISION' && e.data?.verb === 'MARK_DUPLICATE' && e.data?.decision === 'approve');
  let what: string;
  if (idx >= 0) {
    entries[idx]!.actor = 'human:dana.ortiz@acme-fab.example.com';
    what = 'changed who approved the duplicate rejection';
  } else {
    idx = Math.floor(entries.length / 2);
    entries[idx]!.summary += ' (edited)';
    what = 'edited an entry summary';
  }
  lines[idx] = JSON.stringify(entries[idx]);
  writeFileSync(dest, lines.join('\n') + '\n');
  return { seq: entries[idx]!.seq, what };
}

function truncateCopy(src: string, dest: string, drop: number): void {
  const lines = readFileSync(src, 'utf8').trimEnd().split('\n');
  writeFileSync(dest, lines.slice(0, Math.max(0, lines.length - drop)).join('\n') + '\n');
}

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

function wrap(text: string, indent: string, width = 100): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width - indent.length) {
      lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}
