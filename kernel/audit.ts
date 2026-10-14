import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256Hex } from './canonical.ts';
import type { Json } from './canonical.ts';
import { isActor, isHumanId } from './identity.ts';
import type { Actor } from './identity.ts';

// Append-only, hash-chained audit log.
//
// Each entry stores the hash of the entry before it (prevHash) and its own
// hash: SHA-256 over the canonical JSON of every other field. Changing any
// byte of any entry changes its hash, which no longer matches the prevHash
// stored in the next entry, so verification pinpoints the first entry that
// was altered, removed, inserted or reordered. Removing entries from the end
// leaves a shorter chain that is still internally valid; record the head hash
// somewhere else (a ticket, the close binder) and pass it to verify to catch
// that too.

export const AUDIT_KINDS = Object.freeze([
  'SYSTEM',          // kernel bookkeeping: policy loaded, data ingested, case opened
  'READ',            // an agent read a record; the snapshot digest is recorded
  'INFERENCE',       // a planner ran (playbook or model) and what it returned
  'PROPOSAL',        // the kernel accepted or rejected a planner's proposal
  'POLICY_DECISION', // the policy engine's outcome for one proposed action
  'HUMAN_DECISION',  // a person approved or rejected one action
  'ACTION',          // the executor changed a record, under a named person's authority
  'REFUSAL',         // something was attempted and refused, with the reason
] as const);
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  seq: number;
  at: string;
  kind: AuditKind;
  actor: Actor;
  caseId: string | null;
  summary: string;
  data: Json;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Kinds whose actor must be a person. Enforced on write and on verify. */
const HUMAN_ONLY_KINDS: ReadonlySet<AuditKind> = new Set(['HUMAN_DECISION', 'ACTION']);

export class AuditError extends Error {
  override name = 'AuditError';
}

export interface AuditLogOptions {
  /** JSONL file to append to. Omit for an in-memory log. */
  file?: string;
  /** Clock for timestamps. The demo injects a deterministic one. */
  clock?: () => Date;
}

export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #file: string | undefined;
  readonly #clock: () => Date;

  constructor(opts: AuditLogOptions = {}) {
    this.#file = opts.file;
    this.#clock = opts.clock ?? (() => new Date());
    if (this.#file && existsSync(this.#file)) {
      const existing = readAuditFile(this.#file);
      const result = verifyChain(existing.entries, { parseProblems: existing.problems });
      if (!result.ok) {
        throw new AuditError(`refusing to append to ${this.#file}: chain is broken at seq ${result.firstBadSeq} (${result.problem})`);
      }
      this.#entries.push(...existing.entries);
    }
    if (this.#file) mkdirSync(dirname(this.#file), { recursive: true });
  }

  append(kind: AuditKind, actor: Actor, caseId: string | null, summary: string, data: unknown = null): AuditEntry {
    if (!AUDIT_KINDS.includes(kind)) throw new AuditError(`unknown audit kind ${kind}`);
    if (!isActor(actor)) throw new AuditError(`invalid actor ${JSON.stringify(actor)}`);
    if (HUMAN_ONLY_KINDS.has(kind) && !isHumanId(actor)) {
      throw new AuditError(`${kind} entries must carry a human identity; got ${actor}`);
    }
    const prev = this.#entries[this.#entries.length - 1];
    const body = {
      seq: (prev?.seq ?? 0) + 1,
      at: this.#clock().toISOString(),
      kind,
      actor,
      caseId,
      summary,
      data: JSON.parse(canonicalJson(data)) as Json,
      prevHash: prev?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = Object.freeze({ ...body, hash: hashEntry(body) });
    if (this.#file) appendFileSync(this.#file, JSON.stringify(entry) + '\n');
    this.#entries.push(entry);
    return entry;
  }

  entries(): readonly AuditEntry[] {
    return [...this.#entries];
  }

  head(): string {
    return this.#entries[this.#entries.length - 1]?.hash ?? GENESIS_HASH;
  }
}

export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  const { seq, at, kind, actor, caseId, summary, data, prevHash } = entry;
  return sha256Hex(canonicalJson({ seq, at, kind, actor, caseId, summary, data, prevHash }));
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  head: string;
  firstBadSeq: number | null;
  problem: string | null;
}

export interface VerifyOptions {
  /** Head hash recorded out-of-band. Catches removal of entries from the end. */
  expectedHead?: string;
  /** Problems found while parsing the file, reported as a failure. */
  parseProblems?: string[];
}

export function verifyChain(entries: readonly AuditEntry[], opts: VerifyOptions = {}): VerifyResult {
  const fail = (seq: number | null, problem: string, count: number, head: string): VerifyResult => ({
    ok: false, count, head, firstBadSeq: seq, problem,
  });
  if (opts.parseProblems?.length) return fail(null, opts.parseProblems[0]!, entries.length, GENESIS_HASH);

  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return fail(e.seq, `expected seq ${expectedSeq}, found ${e.seq} (entry removed, inserted or reordered)`, entries.length, prevHash);
    if (e.prevHash !== prevHash) return fail(e.seq, 'prevHash does not match the hash of the previous entry', entries.length, prevHash);
    if (hashEntry(e) !== e.hash) return fail(e.seq, 'entry content does not match its hash (entry was edited)', entries.length, prevHash);
    if (!AUDIT_KINDS.includes(e.kind)) return fail(e.seq, `unknown kind ${e.kind}`, entries.length, prevHash);
    if (HUMAN_ONLY_KINDS.has(e.kind) && !isHumanId(e.actor)) {
      return fail(e.seq, `${e.kind} entry has a non-human actor ${e.actor}`, entries.length, prevHash);
    }
    prevHash = e.hash;
    expectedSeq += 1;
  }
  if (opts.expectedHead && opts.expectedHead !== prevHash) {
    return fail(null, `head ${prevHash.slice(0, 16)}… does not match the expected head ${opts.expectedHead.slice(0, 16)}… (entries missing from the end, or a different log)`, entries.length, prevHash);
  }
  return { ok: true, count: entries.length, head: prevHash, firstBadSeq: null, problem: null };
}

export function readAuditFile(file: string): { entries: AuditEntry[]; problems: string[] } {
  const entries: AuditEntry[] = [];
  const problems: string[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      problems.push(`line ${i + 1} is not valid JSON`);
    }
  });
  return { entries, problems };
}

export function verifyAuditFile(file: string, opts: Omit<VerifyOptions, 'parseProblems'> = {}): VerifyResult {
  const { entries, problems } = readAuditFile(file);
  return verifyChain(entries, { ...opts, parseProblems: problems });
}
