import type { Case, ConfidenceBand, ExceptionType } from './types.ts';
import { CONFIDENCE_BANDS, EXCEPTION_TYPES } from './types.ts';
import { VERBS, VERB_NAMES, isVerb } from './verbs.ts';
import type { Verb, VerbContext } from './verbs.ts';

// A planner (deterministic playbook or language model) returns a proposal in
// one wire format. The kernel treats every planner as untrusted, including
// its own playbooks: the same validation runs no matter who planned.
//
// Wire actions are flat objects with one field per possible parameter and
// null for the ones a verb does not use. That keeps the JSON schema simple
// enough for every model provider's structured-output mode; the kernel turns
// it into a typed action here.

export const WIRE_ACTION_FIELDS = Object.freeze([
  'invoiceId', 'reasonCode', 'to', 'subject', 'body', 'amountUsd',
  'duplicateOfInvoiceId', 'assignee', 'title', 'reason',
] as const);
export type WireField = (typeof WIRE_ACTION_FIELDS)[number];

export type WireAction = { verb: string; rationale: string } & { [K in WireField]: K extends 'amountUsd' ? number | null : string | null };

export interface WireProposal {
  classification: string;
  diagnosis: string;
  confidence: string;
  citations: string[];
  actions: WireAction[];
}

export interface ProposedAction {
  verb: Verb;
  params: Readonly<Record<string, string | number>>;
  rationale: string;
}

export interface Proposal {
  caseId: string;
  classification: ExceptionType;
  diagnosis: string;
  confidenceBand: ConfidenceBand;
  /** Mapped from the band, then capped by the kernel if evidence is thin. */
  confidence: number;
  citations: string[];
  actions: ProposedAction[];
  plannedBy: string;
}

export const MAX_ACTIONS_PER_PROPOSAL = 6;

export type ValidationResult = { ok: true; proposal: Proposal } | { ok: false; errors: string[] };

export function validateProposal(raw: unknown, ctx: VerbContext, plannedBy: string): ValidationResult {
  const errors: string[] = [];
  const c: Case = ctx.caseRecord;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['proposal must be a JSON object'] };
  const p = raw as Partial<WireProposal>;

  if (!(EXCEPTION_TYPES as readonly string[]).includes(String(p.classification))) {
    errors.push(`classification must be one of ${EXCEPTION_TYPES.join(', ')}`);
  }
  if (typeof p.diagnosis !== 'string' || !p.diagnosis.trim()) errors.push('diagnosis is required');
  else if (p.diagnosis.length > 2000) errors.push('diagnosis exceeds 2000 characters');

  const band = String(p.confidence) as ConfidenceBand;
  if (!Object.hasOwn(CONFIDENCE_BANDS, band)) errors.push(`confidence must be one of ${Object.keys(CONFIDENCE_BANDS).join(', ')}`);

  // Every citation must point at evidence the kernel recorded for this case.
  const known = new Set(c.evidence.map((e) => e.id));
  const citations = Array.isArray(p.citations) ? p.citations.map(String) : [];
  if (!citations.length) errors.push('at least one citation is required');
  for (const id of citations) if (!known.has(id)) errors.push(`citation ${id} is not evidence recorded for ${c.id}`);

  const actions: ProposedAction[] = [];
  if (!Array.isArray(p.actions) || !p.actions.length) errors.push('at least one action is required (use ESCALATE when nothing else fits)');
  else if (p.actions.length > MAX_ACTIONS_PER_PROPOSAL) errors.push(`at most ${MAX_ACTIONS_PER_PROPOSAL} actions per proposal`);
  else {
    p.actions.forEach((a, i) => {
      const result = normalizeAction(a, ctx);
      if (result.ok) actions.push(result.action);
      else errors.push(...result.errors.map((e) => `actions[${i}]: ${e}`));
    });
  }

  if (errors.length) return { ok: false, errors };

  // Deterministic cap: a proposal resting on fewer than two pieces of evidence
  // cannot claim more than medium confidence, whatever the planner said.
  const mapped = CONFIDENCE_BANDS[band];
  const confidence = c.evidence.length < 2 ? Math.min(mapped, CONFIDENCE_BANDS.medium) : mapped;

  return {
    ok: true,
    proposal: {
      caseId: c.id,
      classification: p.classification as ExceptionType,
      diagnosis: p.diagnosis!.trim(),
      confidenceBand: band,
      confidence,
      citations,
      actions,
      plannedBy,
    },
  };
}

type NormalizeResult = { ok: true; action: ProposedAction } | { ok: false; errors: string[] };

export function normalizeAction(raw: unknown, ctx: VerbContext): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['action must be an object'] };
  const a = raw as Record<string, unknown>;
  if (!isVerb(a.verb)) {
    return { ok: false, errors: [`verb ${JSON.stringify(a.verb)} is not in the kernel vocabulary (${VERB_NAMES.join(', ')})`] };
  }
  const spec = VERBS[a.verb];
  const errors: string[] = [];
  const params: Record<string, string | number> = {};
  for (const [field, type] of Object.entries(spec.fields)) {
    const value = a[field];
    if (value === null || value === undefined || value === '') errors.push(`${a.verb} requires ${field}`);
    else if (typeof value !== type) errors.push(`${a.verb}.${field} must be a ${type}`);
    else if (type === 'number' && !Number.isFinite(value)) errors.push(`${a.verb}.${field} must be finite`);
    else params[field] = value as string | number;
  }
  if (typeof a.rationale !== 'string' || !a.rationale.trim()) errors.push('rationale is required');
  if (errors.length) return { ok: false, errors };
  const problems = spec.check(params, ctx);
  if (problems.length) return { ok: false, errors: problems.map((m) => `${a.verb}: ${m}`) };
  return { ok: true, action: { verb: a.verb, params: Object.freeze(params), rationale: String(a.rationale).trim() } };
}

/** Build a wire action with every unused field set to null. */
export function wireAction(verb: Verb, rationale: string, fields: Partial<Record<WireField, string | number>>): WireAction {
  const out: Record<string, unknown> = { verb, rationale };
  for (const f of WIRE_ACTION_FIELDS) out[f] = fields[f] ?? null;
  return out as WireAction;
}
