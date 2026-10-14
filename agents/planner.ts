import type { ExceptionType, Finding } from '../kernel/types.ts';
import type { HumanId } from '../kernel/identity.ts';
import type { FieldType, Verb } from '../kernel/verbs.ts';

// A planner turns a case's evidence into a proposal. Two kinds ship here:
// deterministic playbooks (the default, no network) and language-model
// adapters. Both return the same wire-format proposal, and the kernel
// validates both the same way. A planner has no handle on the store, the
// executor or the policy; all it can do is return data.

export interface PlanningInput {
  companyName: string;
  caseId: string;
  invoiceId: string;
  primaryType: ExceptionType;
  findings: Finding[];
  evidence: { id: string; source: string; ref: string; summary: string; snapshot: unknown }[];
  supplier: { id: string; name: string; apEmail: string };
  invoice: { id: string; supplierInvoiceNo: string; totalUsd: number; poId: string | null };
  /** Supplier-supplied free text. Untrusted. */
  untrustedText: { field: string; text: string }[];
  /** People a task may be assigned to. */
  people: { id: HumanId; name: string; role: string }[];
  verbs: { verb: Verb; summary: string; fields: Readonly<Record<string, FieldType>> }[];
}

export interface PlanResult {
  /** Wire-format proposal (see kernel/proposal.ts). Validated by the kernel, never trusted. */
  raw: unknown;
  /** Model that produced it, when a model did. */
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface Planner {
  /** Stable identifier recorded in the audit log, e.g. "playbook:invoice-exception@1". */
  readonly id: string;
  plan(input: PlanningInput): Promise<PlanResult>;
}

export class PlannerError extends Error {
  override name = 'PlannerError';
}
