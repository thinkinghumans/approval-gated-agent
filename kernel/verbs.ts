import type { Case, Invoice } from './types.ts';
import type { Store } from './store.ts';
import type { HumanId } from './identity.ts';
import type { Person } from './policy.ts';
import { hasAtMostTwoDecimals, usd } from './money.ts';

// The closed action vocabulary. These eight verbs are everything the system
// can do to a business record. There is no verb that pays, schedules a
// payment, changes bank details, edits supplier master data, or sends an
// email. Adding one means changing this file, passing review, and shipping a
// new release; nothing at runtime (configuration, a planner, a plugin, a
// prompt) can extend the table. The table and every entry in it are frozen,
// and lookups only consider own properties of a null-prototype object.

export const VERB_NAMES = Object.freeze([
  'PLACE_HOLD',
  'RELEASE_HOLD',
  'DRAFT_SUPPLIER_EMAIL',
  'REQUEST_CREDIT_MEMO',
  'MARK_DUPLICATE',
  'REQUEST_RETRO_PO',
  'CREATE_TASK',
  'ESCALATE',
] as const);

export type Verb = (typeof VERB_NAMES)[number];

export interface VerbParams {
  PLACE_HOLD: { invoiceId: string; reasonCode: string };
  RELEASE_HOLD: { invoiceId: string };
  DRAFT_SUPPLIER_EMAIL: { invoiceId: string; to: string; subject: string; body: string };
  REQUEST_CREDIT_MEMO: { invoiceId: string; to: string; amountUsd: number; subject: string; body: string };
  MARK_DUPLICATE: { invoiceId: string; duplicateOfInvoiceId: string };
  REQUEST_RETRO_PO: { invoiceId: string; assignee: string; body: string };
  CREATE_TASK: { invoiceId: string; assignee: string; title: string; body: string };
  ESCALATE: { invoiceId: string; reason: string };
}

export type FieldType = 'string' | 'number';

/** What a verb can see when the kernel checks or prices it. */
export interface VerbContext {
  readonly store: Store;
  readonly caseRecord: Case;
  readonly directory: Readonly<Record<string, Person>>;
}

/** What a verb can see when the executor applies it. */
export interface ExecutionContext extends VerbContext {
  readonly authorizedBy: HumanId;
}

interface VerbSpec<V extends Verb> {
  readonly verb: V;
  readonly summary: string;
  readonly fields: { readonly [K in keyof VerbParams[V]]: FieldType };
  /** Kernel rule: a person must approve every use of this verb, whatever the policy says. */
  readonly kernelHumanOnly: boolean;
  /** Dollars at stake, computed from records. Planners do not get a say in this number. */
  amountAtStakeUsd(params: VerbParams[V], ctx: VerbContext): number;
  /** Returns problems; empty means the action is well-formed against current records. */
  check(params: VerbParams[V], ctx: VerbContext): string[];
  /** Applies the effect and returns a one-line result for the audit log. */
  apply(params: VerbParams[V], ctx: ExecutionContext): string;
}

/** Runtime view of a verb spec, used by code that handles any verb. */
export interface RuntimeVerbSpec {
  readonly verb: Verb;
  readonly summary: string;
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly kernelHumanOnly: boolean;
  amountAtStakeUsd(params: Readonly<Record<string, unknown>>, ctx: VerbContext): number;
  check(params: Readonly<Record<string, unknown>>, ctx: VerbContext): string[];
  apply(params: Readonly<Record<string, unknown>>, ctx: ExecutionContext): string;
}

function define<V extends Verb>(spec: VerbSpec<V>): RuntimeVerbSpec {
  return Object.freeze({ ...spec, fields: Object.freeze({ ...spec.fields }) }) as unknown as RuntimeVerbSpec;
}

// ---- shared checks ----------------------------------------------------------

function caseInvoice(invoiceId: string, ctx: VerbContext, problems: string[]): Invoice | undefined {
  if (invoiceId !== ctx.caseRecord.invoiceId) {
    problems.push(`invoiceId ${invoiceId} is not this case's invoice (${ctx.caseRecord.invoiceId}); a case may only act on its own invoice`);
    return undefined;
  }
  const inv = ctx.store.invoices.get(invoiceId);
  if (!inv) problems.push(`invoice ${invoiceId} not found`);
  return inv;
}

function text(value: string, field: string, max: number, problems: string[]): void {
  if (!value.trim()) problems.push(`${field} must not be empty`);
  if (value.length > max) problems.push(`${field} exceeds ${max} characters`);
}

function supplierRecipient(to: string, inv: Invoice | undefined, ctx: VerbContext, problems: string[]): void {
  if (!inv) return;
  const supplier = ctx.store.suppliers.get(inv.supplierId);
  if (!supplier || to.trim().toLowerCase() !== supplier.apEmail.toLowerCase()) {
    problems.push(`recipient ${to} is not the AP contact on the supplier master (${supplier?.apEmail ?? 'unknown'})`);
  }
}

function assigneeInDirectory(assignee: string, ctx: VerbContext, problems: string[]): void {
  if (!Object.hasOwn(ctx.directory, assignee)) {
    problems.push(`assignee ${assignee} is not a person in the policy directory`);
  }
}

function notAlreadyRejected(inv: Invoice | undefined, problems: string[]): void {
  if (inv?.status === 'rejected_duplicate') problems.push(`invoice ${inv.id} is already rejected as a duplicate`);
}

function mustGet(ctx: VerbContext, invoiceId: string): Invoice {
  const inv = ctx.store.invoices.get(invoiceId);
  if (!inv) throw new Error(`invoice ${invoiceId} vanished between check and apply`);
  return inv;
}

// ---- the table --------------------------------------------------------------

const table = {
  PLACE_HOLD: define({
    verb: 'PLACE_HOLD',
    summary: 'Put the case invoice on a payment hold with a reason code. Protective: it stops money, it never moves it.',
    fields: { invoiceId: 'string', reasonCode: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: () => 0,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      notAlreadyRejected(inv, problems);
      if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(p.reasonCode)) problems.push('reasonCode must be UPPER_SNAKE_CASE, 3-40 characters');
      return problems;
    },
    apply(p, ctx) {
      const inv = mustGet(ctx, p.invoiceId);
      inv.status = 'on_hold';
      inv.holdReason = p.reasonCode;
      return `Invoice ${inv.id} on hold (${p.reasonCode})`;
    },
  }),

  RELEASE_HOLD: define({
    verb: 'RELEASE_HOLD',
    summary: 'Release the hold so the invoice returns to the normal payables queue. Always needs a person.',
    fields: { invoiceId: 'string' },
    kernelHumanOnly: true,
    amountAtStakeUsd: (p, ctx) => ctx.store.invoices.get(p.invoiceId)?.totalUsd ?? 0,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      if (inv && inv.status !== 'on_hold') problems.push(`invoice ${inv.id} is not on hold`);
      return problems;
    },
    apply(p, ctx) {
      const inv = mustGet(ctx, p.invoiceId);
      inv.status = 'open';
      inv.holdReason = null;
      return `Hold released on ${inv.id}; invoice back in the payables queue`;
    },
  }),

  DRAFT_SUPPLIER_EMAIL: define({
    verb: 'DRAFT_SUPPLIER_EMAIL',
    summary: 'Draft a query to the supplier AP contact on file. Lands in the outbox; a person sends it.',
    fields: { invoiceId: 'string', to: 'string', subject: 'string', body: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: () => 0,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      supplierRecipient(p.to, inv, ctx, problems);
      text(p.subject, 'subject', 200, problems);
      text(p.body, 'body', 4000, problems);
      return problems;
    },
    apply(p, ctx) {
      const id = ctx.store.nextId('DRAFT');
      ctx.store.outbox.push({
        id, caseId: ctx.caseRecord.id, invoiceId: p.invoiceId, kind: 'supplier_query',
        to: p.to, subject: p.subject, body: p.body, amountUsd: null, status: 'draft', authorizedBy: ctx.authorizedBy,
      });
      return `Draft ${id} to ${p.to} placed in the outbox (not sent)`;
    },
  }),

  REQUEST_CREDIT_MEMO: define({
    verb: 'REQUEST_CREDIT_MEMO',
    summary: 'Draft a credit memo request to the supplier AP contact on file for a stated amount. Lands in the outbox; a person sends it.',
    fields: { invoiceId: 'string', to: 'string', amountUsd: 'number', subject: 'string', body: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: (p) => p.amountUsd,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      supplierRecipient(p.to, inv, ctx, problems);
      if (!(p.amountUsd > 0)) problems.push('amountUsd must be positive');
      if (!hasAtMostTwoDecimals(p.amountUsd)) problems.push('amountUsd must be whole cents');
      if (inv && p.amountUsd > inv.totalUsd) problems.push(`amountUsd ${usd(p.amountUsd)} exceeds the invoice total ${usd(inv.totalUsd)}`);
      text(p.subject, 'subject', 200, problems);
      text(p.body, 'body', 4000, problems);
      return problems;
    },
    apply(p, ctx) {
      const id = ctx.store.nextId('DRAFT');
      ctx.store.outbox.push({
        id, caseId: ctx.caseRecord.id, invoiceId: p.invoiceId, kind: 'credit_memo_request',
        to: p.to, subject: p.subject, body: p.body, amountUsd: p.amountUsd, status: 'draft', authorizedBy: ctx.authorizedBy,
      });
      return `Credit memo request ${id} for ${usd(p.amountUsd)} to ${p.to} placed in the outbox (not sent)`;
    },
  }),

  MARK_DUPLICATE: define({
    verb: 'MARK_DUPLICATE',
    summary: 'Reject the case invoice as a duplicate of an earlier invoice from the same supplier. Removes it from the payables queue.',
    fields: { invoiceId: 'string', duplicateOfInvoiceId: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: (p, ctx) => ctx.store.invoices.get(p.invoiceId)?.totalUsd ?? 0,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      notAlreadyRejected(inv, problems);
      const original = ctx.store.invoices.get(p.duplicateOfInvoiceId);
      if (!original) problems.push(`original invoice ${p.duplicateOfInvoiceId} not found`);
      else {
        if (original.id === p.invoiceId) problems.push('an invoice cannot duplicate itself');
        if (inv && original.supplierId !== inv.supplierId) problems.push('original invoice belongs to a different supplier');
        if (original.status === 'rejected_duplicate') problems.push(`original ${original.id} is itself a rejected duplicate`);
      }
      return problems;
    },
    apply(p, ctx) {
      const inv = mustGet(ctx, p.invoiceId);
      inv.status = 'rejected_duplicate';
      inv.holdReason = `DUPLICATE_OF_${p.duplicateOfInvoiceId}`;
      return `Invoice ${inv.id} rejected as a duplicate of ${p.duplicateOfInvoiceId} (${usd(inv.totalUsd)} kept out of the payables queue)`;
    },
  }),

  REQUEST_RETRO_PO: define({
    verb: 'REQUEST_RETRO_PO',
    summary: 'Ask a named buyer to raise a retrospective purchase order, or to dispute the spend, for an invoice that arrived without a valid PO.',
    fields: { invoiceId: 'string', assignee: 'string', body: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: (p, ctx) => ctx.store.invoices.get(p.invoiceId)?.totalUsd ?? 0,
    check(p, ctx) {
      const problems: string[] = [];
      const inv = caseInvoice(p.invoiceId, ctx, problems);
      if (inv && inv.poId && ctx.store.purchaseOrders.has(inv.poId)) problems.push(`invoice ${inv.id} already references a valid PO (${inv.poId})`);
      assigneeInDirectory(p.assignee, ctx, problems);
      text(p.body, 'body', 4000, problems);
      return problems;
    },
    apply(p, ctx) {
      const id = ctx.store.nextId('TASK');
      const inv = mustGet(ctx, p.invoiceId);
      ctx.store.tasks.push({
        id, caseId: ctx.caseRecord.id, invoiceId: inv.id, kind: 'retro_po', assignee: p.assignee as HumanId,
        title: `Retro PO or dispute: ${inv.supplierInvoiceNo} (${usd(inv.totalUsd)})`, body: p.body, status: 'open', authorizedBy: ctx.authorizedBy,
      });
      return `Task ${id} assigned to ${p.assignee}: raise a retro PO or dispute ${inv.id}`;
    },
  }),

  CREATE_TASK: define({
    verb: 'CREATE_TASK',
    summary: 'Assign an internal follow-up task (for example a receiving recount) to a named person in the directory.',
    fields: { invoiceId: 'string', assignee: 'string', title: 'string', body: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: () => 0,
    check(p, ctx) {
      const problems: string[] = [];
      caseInvoice(p.invoiceId, ctx, problems);
      assigneeInDirectory(p.assignee, ctx, problems);
      text(p.title, 'title', 200, problems);
      text(p.body, 'body', 4000, problems);
      return problems;
    },
    apply(p, ctx) {
      const id = ctx.store.nextId('TASK');
      ctx.store.tasks.push({
        id, caseId: ctx.caseRecord.id, invoiceId: p.invoiceId, kind: 'general', assignee: p.assignee as HumanId,
        title: p.title, body: p.body, status: 'open', authorizedBy: ctx.authorizedBy,
      });
      return `Task ${id} assigned to ${p.assignee}: ${p.title}`;
    },
  }),

  ESCALATE: define({
    verb: 'ESCALATE',
    summary: 'Hand the case to the controller queue with a reason, when no other verb fits or the evidence conflicts.',
    fields: { invoiceId: 'string', reason: 'string' },
    kernelHumanOnly: false,
    amountAtStakeUsd: () => 0,
    check(p, ctx) {
      const problems: string[] = [];
      caseInvoice(p.invoiceId, ctx, problems);
      text(p.reason, 'reason', 1000, problems);
      return problems;
    },
    apply(p, ctx) {
      ctx.caseRecord.escalationReason = p.reason;
      return `Case ${ctx.caseRecord.id} escalated: ${p.reason}`;
    },
  }),
} satisfies Record<Verb, RuntimeVerbSpec>;

/** Frozen, null-prototype verb table. The only source of effects in the system. */
export const VERBS: Readonly<Record<Verb, RuntimeVerbSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<Verb, RuntimeVerbSpec>, table),
);

export function isVerb(name: unknown): name is Verb {
  return typeof name === 'string' && Object.hasOwn(VERBS, name);
}
