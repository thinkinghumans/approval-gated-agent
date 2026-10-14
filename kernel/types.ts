import type { HumanId } from './identity.ts';
import type { Verb } from './verbs.ts';
import type { PolicyDecision } from './policy.ts';
import type { Proposal } from './proposal.ts';

// Domain types for a three-way-match accounts payable flow: purchase orders,
// goods receipts, supplier invoices, and the cases the agent opens when the
// three do not agree. All money is US dollars.

// ---- Source records ---------------------------------------------------------

export interface Supplier {
  id: string;
  name: string;
  /** Accounts-receivable contact on the supplier master. Outbound drafts may only go here. */
  apEmail: string;
  paymentTermsDays: number;
}

export interface PurchaseOrderLine {
  line: number;
  sku: string;
  description: string;
  qty: number;
  unitPriceUsd: number;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  buyer: HumanId;
  orderedOn: string;
  lines: PurchaseOrderLine[];
}

export interface ReceiptLine {
  sku: string;
  qtyReceived: number;
}

export interface Receipt {
  id: string;
  poId: string;
  receivedOn: string;
  receivedBy: HumanId;
  lines: ReceiptLine[];
}

export interface InvoiceLine {
  sku: string;
  description: string;
  qty: number;
  unitPriceUsd: number;
}

export type InvoiceStatus = 'open' | 'on_hold' | 'rejected_duplicate';

export interface Invoice {
  id: string;
  supplierId: string;
  supplierInvoiceNo: string;
  poId: string | null;
  invoiceDate: string;
  dueDate: string;
  receivedOn: string;
  lines: InvoiceLine[];
  totalUsd: number;
  /** Free text supplied by the supplier. Untrusted: evidence, never instructions. */
  memo: string | null;
  status: InvoiceStatus;
  holdReason: string | null;
}

export type DatasetInvoice = Omit<Invoice, 'status' | 'holdReason' | 'memo'> & { memo?: string | null };

export interface Dataset {
  company: { name: string; currency: 'USD' };
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  receipts: Receipt[];
  invoices: DatasetInvoice[];
}

// ---- Exceptions and cases ---------------------------------------------------

export const EXCEPTION_TYPES = Object.freeze(['DUPLICATE_INVOICE', 'MISSING_PO', 'PRICE_VARIANCE', 'QTY_VARIANCE'] as const);
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/**
 * Planners state confidence as a band, never a bare float. The kernel maps
 * bands to numbers; calibrating these numbers is a measurement job, not
 * something a model gets to decide.
 */
export const CONFIDENCE_BANDS = Object.freeze({ certain: 0.97, high: 0.85, medium: 0.6, low: 0.3 } as const);
export type ConfidenceBand = keyof typeof CONFIDENCE_BANDS;

export interface Finding {
  type: ExceptionType;
  detail: string;
  amountAtStakeUsd: number;
  /** Record ids the finding is based on (invoice, PO, receipts, the original of a duplicate). */
  refs: string[];
  /** Structured facts behind the finding, for playbooks and planners. */
  facts: Record<string, string | number>;
}

export interface Evidence {
  id: string;
  source: string;
  ref: string;
  summary: string;
  snapshot: unknown;
  /** SHA-256 of the canonical snapshot; also written to the audit log. */
  sha256: string;
}

export type CaseState = 'detected' | 'awaiting_human' | 'actions_executed' | 'needs_follow_up' | 'escalated';

export type ActionStatus = 'blocked' | 'auto_approved' | 'awaiting_human' | 'approved' | 'rejected' | 'executed';

export interface CaseAction {
  id: string;
  caseId: string;
  verb: Verb;
  params: Readonly<Record<string, string | number>>;
  rationale: string;
  /** Computed by the kernel from the verb and the records, never taken from the planner. */
  amountAtStakeUsd: number;
  decision: PolicyDecision;
  status: ActionStatus;
  decidedBy: HumanId | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  result: string | null;
  executedAt: string | null;
}

export interface Case {
  id: string;
  invoiceId: string;
  supplierId: string;
  primaryType: ExceptionType;
  findings: Finding[];
  evidence: Evidence[];
  state: CaseState;
  proposal: Proposal | null;
  plannedBy: string | null;
  actions: CaseAction[];
  escalationReason: string | null;
  openedAt: string;
}

// ---- Effects the executor can produce ---------------------------------------

export interface DraftMessage {
  id: string;
  caseId: string;
  invoiceId: string;
  kind: 'supplier_query' | 'credit_memo_request';
  to: string;
  subject: string;
  body: string;
  amountUsd: number | null;
  /** Drafts are never sent by this system. A person sends them from their own mail client. */
  status: 'draft';
  authorizedBy: HumanId;
}

export interface Task {
  id: string;
  caseId: string;
  invoiceId: string;
  kind: 'retro_po' | 'general';
  assignee: HumanId;
  title: string;
  body: string;
  status: 'open';
  authorizedBy: HumanId;
}
