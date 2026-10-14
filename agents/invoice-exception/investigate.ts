import type { CaseReads } from '../../kernel/kernel.ts';
import type { Policy } from '../../kernel/policy.ts';
import type { Case, Evidence, Invoice, Supplier } from '../../kernel/types.ts';
import type { HumanId } from '../../kernel/identity.ts';
import { VERBS, VERB_NAMES } from '../../kernel/verbs.ts';
import type { PlanningInput } from '../planner.ts';

// Investigation gathers the records a person would pull up for this kind of
// exception. Every read goes through the kernel, so each one is logged and
// becomes a piece of evidence with an id the planner must cite.

export function investigate(reads: CaseReads, c: Case, companyName: string, policy: Policy): PlanningInput {
  const evidence: Evidence[] = [];
  const take = (ev: Evidence): Evidence => (evidence.push(ev), ev);

  const invEv = take(reads.invoice(c.invoiceId));
  const inv = invEv.snapshot as Invoice;
  const supEv = take(reads.supplier(c.supplierId));
  const supplier = supEv.snapshot as Supplier;

  const types = new Set(c.findings.map((f) => f.type));
  if (inv.poId) {
    take(reads.purchaseOrder(inv.poId));
    if (types.has('QTY_VARIANCE') || types.has('PRICE_VARIANCE') || types.has('DUPLICATE_INVOICE')) take(reads.receiptsForPo(inv.poId));
  }
  if (types.has('DUPLICATE_INVOICE')) {
    const originalId = String(c.findings.find((f) => f.type === 'DUPLICATE_INVOICE')!.facts.originalInvoiceId);
    take(reads.invoice(originalId));
  }
  if (types.has('MISSING_PO') || types.has('DUPLICATE_INVOICE')) take(reads.supplierInvoices(c.supplierId));

  return {
    companyName,
    caseId: c.id,
    invoiceId: c.invoiceId,
    primaryType: c.primaryType,
    findings: c.findings,
    evidence: evidence.map(({ id, source, ref, summary, snapshot }) => ({ id, source, ref, summary, snapshot })),
    supplier: { id: supplier.id, name: supplier.name, apEmail: supplier.apEmail },
    invoice: { id: inv.id, supplierInvoiceNo: inv.supplierInvoiceNo, totalUsd: inv.totalUsd, poId: inv.poId },
    untrustedText: inv.memo ? [{ field: 'invoice.memo', text: inv.memo }] : [],
    people: Object.entries(policy.directory).map(([id, p]) => ({ id: id as HumanId, name: p.name, role: p.role })),
    verbs: VERB_NAMES.map((v) => ({ verb: v, summary: VERBS[v].summary, fields: VERBS[v].fields })),
  };
}
