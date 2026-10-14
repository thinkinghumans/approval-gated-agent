import type { Finding } from '../../kernel/types.ts';
import { usd } from '../../kernel/money.ts';
import { wireAction } from '../../kernel/proposal.ts';
import type { WireAction, WireProposal } from '../../kernel/proposal.ts';
import type { PlanResult, Planner, PlanningInput } from '../planner.ts';

// Deterministic playbooks: one per exception type, written the way an AP lead
// would describe the standard response. They are the default planner (no
// network, no key), the fallback when a model fails or proposes something
// invalid, and the baseline any model planner should be measured against.

export class PlaybookPlanner implements Planner {
  readonly id = 'playbook:invoice-exception@1';

  async plan(input: PlanningInput): Promise<PlanResult> {
    return { raw: buildProposal(input) };
  }
}

export function buildProposal(input: PlanningInput): WireProposal {
  const f = input.findings[0]!;
  const cite = (source: string, ref?: string) =>
    input.evidence.filter((e) => e.source === source && (ref === undefined || e.ref === ref)).map((e) => e.id);
  const invEv = cite('invoices', input.invoiceId);
  const poEv = input.invoice.poId ? cite('purchase_orders', input.invoice.poId) : [];
  const rcvEv = input.invoice.poId ? cite('receipts', input.invoice.poId) : [];
  const supEv = cite('suppliers', input.supplier.id);
  const hold = (code: string, why: string) => wireAction('PLACE_HOLD', why, { invoiceId: input.invoiceId, reasonCode: code });
  const ref = (ids: string[]) => ids.map((id) => `[${id}]`).join('');
  const person = (role: string) => input.people.find((p) => p.role === role);

  let diagnosis: string;
  let confidence: 'certain' | 'high' | 'medium' | 'low';
  let citations: string[];
  const actions: WireAction[] = [];

  switch (f.type) {
    case 'DUPLICATE_INVOICE': {
      const originalId = String(f.facts.originalInvoiceId);
      const origEv = cite('invoices', originalId);
      const exact = f.facts.basis === 'invoice_number';
      confidence = exact ? 'certain' : 'medium';
      citations = [...invEv, ...origEv];
      diagnosis = exact
        ? `${input.invoice.supplierInvoiceNo} ${ref(invEv)} repeats supplier invoice ${f.facts.originalSupplierInvoiceNo} already on file as ${originalId} ${ref(origEv)} for the same ${usd(input.invoice.totalUsd)}. Paying both would pay for the same goods twice.`
        : `${input.invoiceId} ${ref(invEv)} has the same amount and invoice date as ${originalId} ${ref(origEv)} under a different invoice number. It is likely a re-key of the same bill, but the numbers differ, so a person should confirm.`;
      actions.push(
        hold('SUSPECTED_DUPLICATE', 'Stop the copy from reaching a payment run while the duplicate is confirmed.'),
        wireAction('MARK_DUPLICATE', `Same supplier, ${exact ? 'same invoice number' : 'same amount and date'}, and ${originalId} arrived first.`, {
          invoiceId: input.invoiceId, duplicateOfInvoiceId: originalId,
        }),
      );
      break;
    }

    case 'MISSING_PO': {
      const historyEv = cite('invoices', `supplier:${input.supplier.id}`);
      confidence = 'high';
      citations = [...invEv, ...poEv, ...historyEv];
      diagnosis = `${f.detail} ${ref(invEv)}${poEv.length ? ` ${ref(poEv)}` : ''}. Without an approved PO there is no authorization for this ${usd(input.invoice.totalUsd)} spend, so the invoice cannot be matched or paid. The buyer needs to raise a retrospective PO or dispute the charge.`;
      const buyer = person('buyer');
      actions.push(hold('NO_VALID_PO', 'No authorized PO to match against; keep it out of payment runs.'));
      if (buyer) {
        actions.push(wireAction('REQUEST_RETRO_PO', 'The budget owner decides whether this spend was authorized.', {
          invoiceId: input.invoiceId,
          assignee: buyer.id,
          body: `${input.supplier.name} invoice ${input.invoice.supplierInvoiceNo} for ${usd(input.invoice.totalUsd)} arrived without a valid purchase order (${f.detail.toLowerCase()}). If this spend was authorized, please raise a retrospective PO so AP can match it. If not, reply and AP will dispute it with the supplier.`,
        }));
      } else {
        actions.push(wireAction('ESCALATE', 'No buyer in the directory to route a retro-PO request to.', {
          invoiceId: input.invoiceId, reason: 'Missing PO and no buyer on file to raise one',
        }));
      }
      break;
    }

    case 'PRICE_VARIANCE': {
      const priceFindings = input.findings.filter((x) => x.type === 'PRICE_VARIANCE');
      const total = sum(priceFindings);
      confidence = 'high';
      citations = [...invEv, ...poEv, ...supEv];
      diagnosis = `${priceFindings.map((x) => x.detail).join('; ')} ${ref(invEv)}${ref(poEv)}. The PO is the agreed price, so the supplier over-billed by ${usd(total)} unless a price change was agreed and not reflected on the PO.`;
      actions.push(
        hold('PRICE_VARIANCE', 'Hold until the price difference is credited or the PO is amended.'),
        creditMemo(input, total, priceFindings, 'Unit price above the PO price; ask for a credit memo for the difference.'),
      );
      break;
    }

    case 'QTY_VARIANCE': {
      const qtyFindings = input.findings.filter((x) => x.type === 'QTY_VARIANCE');
      const total = sum(qtyFindings);
      confidence = 'high';
      citations = [...invEv, ...poEv, ...rcvEv];
      diagnosis = `${qtyFindings.map((x) => x.detail).join('; ')} ${ref(invEv)}${ref(rcvEv)}. Either a delivery was not booked or the supplier billed for goods it did not ship; a receiving recount settles which, and a credit memo for ${usd(total)} resolves the second.`;
      actions.push(
        hold('QTY_VARIANCE', 'Hold until the quantity difference is credited or receiving confirms a later delivery.'),
        creditMemo(input, total, qtyFindings, 'Billed quantity exceeds received quantity; ask for a credit memo for the units not received.'),
      );
      const receiving = person('receiving');
      if (receiving) {
        actions.push(wireAction('CREATE_TASK', 'Rule out a delivery that arrived but was not booked before the supplier is asked for credit.', {
          invoiceId: input.invoiceId,
          assignee: receiving.id,
          title: `Confirm received quantity on ${input.invoice.poId}`,
          body: qtyFindings.map((x) => `${x.facts.sku}: invoice bills ${Number(x.facts.billedQty).toLocaleString('en-US')}, receipts show ${Number(x.facts.receivedQty).toLocaleString('en-US')}.`).join('\n') +
            '\nPlease check the dock log and post any unbooked receipt, or confirm the count stands.',
        }));
      }
      break;
    }
  }

  // Supplier-written text is evidence, never instruction. If it asks for
  // payment to new remittance details (a common fraud pattern), nothing here
  // can act on that, and a person verifies it through a known contact.
  const remittance = input.untrustedText.find((u) => REMITTANCE_CHANGE.test(u.text));
  const controller = person('controller');
  if (remittance && controller && actions.length < 6) {
    const where = remittance.field === 'invoice.memo' ? "supplier's memo on this invoice" : `supplier text in ${remittance.field}`;
    diagnosis += ` The ${where} asks for payment to new remittance details; nothing acted on it, and it needs verification with the supplier through a known contact.`;
    actions.push(wireAction('CREATE_TASK', 'Remittance changes requested in invoice text are a common fraud pattern; verify out of band before anyone updates bank details.', {
      invoiceId: input.invoiceId,
      assignee: controller.id,
      title: `Verify remittance-change request from ${input.supplier.name}`,
      body: `Invoice ${input.invoice.supplierInvoiceNo} contains text asking for payment to new remittance details. Do not change bank details from an invoice or email. Call ${input.supplier.name} at the number already on file to confirm.`,
    }));
  }

  return { classification: f.type, diagnosis, confidence, citations, actions };
}

const REMITTANCE_CHANGE = /\b(remit|remittance|bank|account number|routing|wire|ach)\b/i;

function creditMemo(input: PlanningInput, amount: number, findings: Finding[], rationale: string): WireAction {
  const lines = findings.map((x) => `- ${x.detail}`).join('\n');
  return wireAction('REQUEST_CREDIT_MEMO', rationale, {
    invoiceId: input.invoiceId,
    to: input.supplier.apEmail,
    amountUsd: amount,
    subject: `Credit memo request: invoice ${input.invoice.supplierInvoiceNo}${input.invoice.poId ? ` (PO ${input.invoice.poId})` : ''}`,
    body: [
      `Hello ${input.supplier.name} accounts receivable team,`,
      '',
      `We compared invoice ${input.invoice.supplierInvoiceNo} with our purchase order and receiving records and found:`,
      lines,
      '',
      `Please issue a credit memo for ${usd(amount)}, or send documentation if our records are missing something. The invoice is on hold until this is resolved.`,
      '',
      'Thank you,',
      `Accounts Payable, ${input.companyName}`,
      '',
      'This draft was prepared by our AP software and reviewed by a member of our team before sending.',
    ].join('\n'),
  });
}

function sum(findings: Finding[]): number {
  return Math.round(findings.reduce((s, x) => s + x.amountAtStakeUsd, 0) * 100) / 100;
}
