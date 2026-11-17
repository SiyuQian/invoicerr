import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { decimalsFor } from '@/utils/financial';
import { Prisma, ReconciliationProject } from '../../../prisma/generated/prisma/client';
import type { ReconciliationService } from './service';
import { caseRecord, reconciliationConflict, reconciliationHash } from './service';
import { createDocumentLinkTx, documentMatchesRole, validateDocumentLinkTx } from './document-links';
import { duplicateInvoiceIds, invoiceRecord, saveExternalInvoiceTx } from './external-receipts';
import { assertImportSize, parse, schemas } from './validation';
import type {
  CreateCaseInput,
  ExternalInvoiceInput,
  ImportApplied,
  ImportIssue,
  ImportPreview,
  ImportPreviewInput,
  LedgerlyInvoiceRow,
  LinkDocumentInput,
  MutationContext,
} from './types';

export function sourceAmountMinor(cents: number, currency: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new BadRequestException({
      code: 'INVALID_SOURCE_AMOUNT',
      message: 'Source cents must be nonnegative safe integers.',
    });
  const scaled = BigInt(cents) * 10n ** BigInt(decimalsFor(currency));
  if (scaled % 100n !== 0n || scaled / 100n > 2147483647n)
    throw new BadRequestException({
      code: 'INVALID_SOURCE_AMOUNT',
      message: 'Source cents cannot be represented exactly in project minor units.',
    });
  return Number(scaled / 100n);
}
function normalize<T extends ImportPreviewInput>(data: T): T {
  return {
    ...data,
    payload: {
      ...data.payload,
      invoices: [...data.payload.invoices].sort((a, b) => a.id.localeCompare(b.id)),
    },
    selectedMatches: [...data.selectedMatches].sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.documentId.localeCompare(b.documentId),
    ),
  };
}
const json = (value: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(value));
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const metadata = (snapshot: unknown) => object(object(snapshot).ledgerlyImportV1);
function sourceReference(data: ImportPreviewInput, row: LedgerlyInvoiceRow) {
  return `Ledgerly project ${data.payload.project.id}; row ${row.id}; invoice ${row.number}`;
}
function externalInput(data: ImportPreviewInput, row: LedgerlyInvoiceRow): ExternalInvoiceInput {
  return parse(schemas.externalInvoice, {
    issuer: row.issuer,
    recipient: row.recipient,
    number: row.number,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: data.payload.currency,
    grossMinor: sourceAmountMinor(row.totalCents, data.payload.currency),
    netMinor: sourceAmountMinor(row.exGstAmountCents, data.payload.currency),
    vatMinor: sourceAmountMinor(row.gstAmountCents, data.payload.currency),
    reportedStatus: row.status,
    sourceSystem: 'ledgerly',
    sourceId: row.id,
    sourceAsOf: data.payload.sourceAsOf,
    sourceReference: sourceReference(data, row),
  });
}
function caseInput(
  data: ImportPreviewInput,
  customer: LedgerlyInvoiceRow,
  share?: LedgerlyInvoiceRow,
): CreateCaseInput {
  return parse(schemas.createCase, {
    title: customer.number,
    periodStart: null,
    periodEnd: null,
    agreedGrossMinor: share ? sourceAmountMinor(share.totalCents, data.payload.currency) : null,
    agreedNetMinor: share ? sourceAmountMinor(share.exGstAmountCents, data.payload.currency) : null,
    agreedVatMinor: share ? sourceAmountMinor(share.gstAmountCents, data.payload.currency) : null,
    agreementReference: share ? sourceReference(data, share) : null,
  });
}
function sameFacts(left: unknown, right: unknown) {
  const { sourceAsOf: _a, ...a } = object(left),
    { sourceAsOf: _b, ...b } = object(right);
  return reconciliationHash(a) === reconciliationHash(b);
}
function linkRole(project: ReconciliationProject, row: LedgerlyInvoiceRow): LinkDocumentInput['role'] | null {
  if (row.kind === 'Customer invoice')
    return project.collectionMode === 'COMPANY' ? 'CUSTOMER_INVOICE' : null;
  return project.collectionMode === 'PARTNER' ? 'SETTLEMENT_INCOME' : 'PARTNER_BILL';
}
function linkType(role: LinkDocumentInput['role']): LinkDocumentInput['typeId'] {
  return role === 'PARTNER_BILL' ? 'received-invoice' : 'invoice';
}
/** Exact number is only candidate discovery; source IDs never become document IDs. */
async function candidateDocuments(
  tx: Prisma.TransactionClient,
  project: ReconciliationProject,
  data: ImportPreviewInput,
) {
  const clauses = data.payload.invoices.flatMap((row) => {
    const role = linkRole(project, row);
    return role ? [{ typeId: linkType(role), displayNumber: row.number }] : [];
  });
  const ids = data.selectedMatches.map((match) => match.documentId);
  const existing = await tx.projectDocumentLink.findMany({
    where: { companyId: project.companyId, projectId: project.id },
    select: { documentId: true },
  });
  return tx.documentInstance.findMany({
    where: {
      companyId: project.companyId,
      OR: [...clauses, { id: { in: [...ids, ...existing.map((link) => link.documentId)] } }],
    },
    orderBy: { id: 'asc' },
  });
}
async function loadPlan(
  core: ReconciliationService,
  tx: Prisma.TransactionClient,
  project: ReconciliationProject,
  data: ImportPreviewInput,
): Promise<ImportPreview> {
  const companyId = project.companyId,
    projectId = project.id;
  const preview: ImportPreview = {
    previewHash: '0'.repeat(64),
    sourceHash: reconciliationHash(data.payload),
    projectVersion: (await core.sourceVersion(tx, companyId, project)).versionToken,
    sourceAsOf: data.payload.sourceAsOf,
    proposedCases: [],
    proposedReferences: [],
    proposedLinks: [],
    unresolved: [],
    errors: [],
    counts: {
      sourceRows: data.payload.invoices.length,
      casesToCreate: 0,
      referencesToCreate: 0,
      linksToCreate: 0,
      reused: 0,
      revisions: 0,
      unresolved: 0,
      errors: 0,
    },
  };
  function issue(
    code: string,
    message: string,
    rows: string[] = [],
    caseSourceId: string | null = null,
    blocking = true,
    unresolved = false,
  ) {
    const entry: ImportIssue = { code, message, sourceIds: rows, caseSourceId, blocking };
    (unresolved ? preview.unresolved : preview.errors).push(entry);
  }
  const cases = await tx.reconciliationCase.findMany({
    where: { companyId, source: 'ledgerly' },
    orderBy: { id: 'asc' },
  });
  const refs = await tx.customerInvoiceReference.findMany({
    where: { companyId, source: 'ledgerly' },
    orderBy: { id: 'asc' },
  });
  const links = await tx.projectDocumentLink.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
  const documents = await candidateDocuments(tx, project, data);
  let financial: Awaited<ReturnType<typeof core.financialRead.readMany>>;
  try {
    financial = await core.financialRead.readMany(
      companyId,
      documents
        .filter((doc) => ['invoice', 'received-invoice', 'expense'].includes(doc.typeId))
        .map((doc) => ({ id: doc.id, typeId: doc.typeId as LinkDocumentInput['typeId'] })),
      tx,
    );
  } catch {
    throw new ServiceUnavailableException({
      code: 'FINANCIAL_READ_UNAVAILABLE',
      message: 'Canonical candidate financial sources could not be read.',
    });
  }
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, name: true, currency: true },
  });
  const parties = await tx.client.findMany({
    where: {
      companyId,
      id: { in: [project.endCustomerClientId, project.partnerClientId].filter((id): id is string => !!id) },
    },
    select: { id: true, name: true, isActive: true },
    orderBy: { id: 'asc' },
  });
  if (data.payload.currency !== project.currency)
    issue('CURRENCY_MISMATCH', 'Source currency must equal project currency.');
  const seen = new Set<string>(),
    usable = new Set<string>();
  for (const row of data.payload.invoices) {
    if (seen.has(row.id))
      issue('IMPORT_DUPLICATE_SOURCE_ID', 'Source IDs must be unique in this payload.', [row.id]);
    seen.add(row.id);
    if (
      !row.projectId ||
      row.projectId !== data.payload.project.id ||
      row.projectName !== data.payload.project.name
    )
      issue(
        'IMPORT_SOURCE_MEMBERSHIP',
        'Exact source project membership must be supplied and match the selected source project.',
        [row.id],
        null,
        true,
        true,
      );
    const direction = row.kind === 'Customer invoice' ? 'customer' : 'share';
    if (
      row.issuer !== data.payload.project[`${direction}Issuer`] ||
      row.recipient !== data.payload.project[`${direction}Recipient`]
    )
      issue(
        'IMPORT_SOURCE_PARTY',
        'Source party direction does not match the selected source project.',
        [row.id],
        null,
        true,
        true,
      );
    try {
      const mapped = externalInput(data, row);
      if (mapped.grossMinor !== mapped.netMinor! + mapped.vatMinor!)
        issue('IMPORT_SOURCE_SPLIT', 'Source gross must equal its explicit net and GST amounts.', [row.id]);
      else usable.add(row.id);
    } catch {
      issue(
        'INVALID_SOURCE_AMOUNT',
        'Source dates or cents cannot be represented exactly without rounding.',
        [row.id],
      );
    }
    if (!row.issueDate || !row.dueDate)
      issue(
        'IMPORT_MISSING_DATE',
        'Source invoice dates remain unknown where missing.',
        [row.id],
        null,
        false,
        true,
      );
    if (row.status === 'Paid')
      issue(
        'IMPORT_REPORTED_PAID',
        'Source Paid is historical status only and creates no receipt.',
        [row.id],
        null,
        false,
        true,
      );
  }
  const customers = data.payload.invoices.filter((row) => row.kind === 'Customer invoice');
  const shares = data.payload.invoices.filter((row) => row.kind === 'Internal share');
  const paired = new Map<string, LedgerlyInvoiceRow[]>();
  for (const share of shares) {
    const candidates = customers.filter(
      (customer) =>
        customer.number === share.sourceNumber &&
        (!share.linkedInvoiceNumber || share.linkedInvoiceNumber === customer.number) &&
        (!customer.linkedInvoiceNumber || customer.linkedInvoiceNumber === share.number) &&
        customer.projectId === share.projectId,
    );
    if (candidates.length !== 1) {
      issue(
        'IMPORT_SOURCE_ANCHOR',
        'Share needs one unique explicit customer source anchor; linkedInvoiceNumber refers to the other Ledgerly row.',
        [share.id],
        null,
        true,
        true,
      );
      continue;
    }
    const customer = candidates[0];
    paired.set(customer.id, [...(paired.get(customer.id) ?? []), share]);
  }
  const sourceCase = new Map<string, string>();
  for (const customer of customers) {
    sourceCase.set(customer.id, customer.id);
    const ownShares = paired.get(customer.id) ?? [];
    for (const share of ownShares) sourceCase.set(share.id, customer.id);
    if (ownShares.length > 1)
      issue(
        'IMPORT_SOURCE_ANCHOR',
        'Multiple shares for one customer require manual source review.',
        ownShares.map((row) => row.id),
        customer.id,
        true,
        true,
      );
    if (
      customers.filter(
        (other) =>
          other.number === customer.number &&
          other.issuer === customer.issuer &&
          other.recipient === customer.recipient,
      ).length > 1
    )
      issue(
        'IMPORT_DUPLICATE_REFERENCE',
        'Duplicate contextual customer invoice numbers require review.',
        [customer.id],
        customer.id,
        true,
        true,
      );
    if (
      customer.linkedInvoiceNumber &&
      !ownShares.some((share) => share.number === customer.linkedInvoiceNumber)
    )
      issue(
        'IMPORT_SOURCE_ANCHOR',
        'Customer points to a missing or inconsistent share source row.',
        [customer.id],
        customer.id,
        true,
        true,
      );
    if (!usable.has(customer.id) || ownShares.some((share) => !usable.has(share.id))) continue;
    const proposed = caseInput(data, customer, ownShares[0]);
    try {
      core.checkAgreement(project, proposed);
    } catch {
      issue(
        'IMPORT_AGREEMENT_PARTNER',
        'Explicit agreement requires a project partner.',
        [customer.id],
        customer.id,
      );
    }
    const current = cases.find((row) => row.externalId === customer.id);
    const caseMeta = {
      project: data.payload.project,
      rows: [customer, ...ownShares].sort((a, b) => a.id.localeCompare(b.id)),
      proposed,
    };
    const caseSnapshot = {
      sourceSystem: 'ledgerly',
      sourceId: customer.id,
      sourceAsOf: data.payload.sourceAsOf,
      ledgerlyImportV1: caseMeta,
    };
    const acceptedRows =
      current && Array.isArray(metadata(current.sourceSnapshot).rows)
        ? (metadata(current.sourceSnapshot).rows as unknown[])
        : [];
    const newShareIdentity = ownShares.some(
      (share) =>
        !acceptedRows.some((row) => object(row).kind === 'Internal share' && object(row).id === share.id),
    );
    let action: ImportPreview['proposedCases'][number]['action'] = current ? 'REUSE' : 'CREATE';
    if (
      current &&
      (newShareIdentity ||
        current.projectId !== projectId ||
        (metadata(current.sourceSnapshot).project &&
          object(metadata(current.sourceSnapshot).project).id !== data.payload.project.id) ||
        (!sameFacts(metadata(current.sourceSnapshot).proposed, proposed) &&
          !sameFacts(
            parse(
              schemas.createCase,
              Object.fromEntries(
                Object.keys(schemas.createCase.shape).map((key) => [key, caseRecord(current)[key]]),
              ),
            ),
            proposed,
          )))
    ) {
      action = 'REVISION';
      issue(
        'IMPORT_SOURCE_REVISION',
        newShareIdentity
          ? 'Introducing or rebinding a raw share source on an existing case is not supported. Preserve its original source identities.'
          : 'Existing case differs from proposed source facts. Review through explicit case forms; import will not overwrite.',
        [customer.id],
        customer.id,
      );
    }
    for (const source of [customer, ...ownShares]) {
      const conflicting = cases.find(
        (other) =>
          other.externalId !== customer.id &&
          (other.externalId === source.id ||
            (Array.isArray(metadata(other.sourceSnapshot).rows) &&
              (metadata(other.sourceSnapshot).rows as unknown[]).some(
                (row) => object(row).id === source.id,
              ))),
      );
      const conflictingReference = refs.find(
        (ref) =>
          ref.externalId === source.id &&
          (source.kind === 'Internal share' || ref.projectId !== projectId || ref.caseId !== current?.id),
      );
      if (conflicting || conflictingReference)
        issue(
          'IMPORT_SOURCE_IDENTITY_CONFLICT',
          'This raw source row is already associated with another case or project.',
          [source.id],
          customer.id,
        );
    }
    preview.proposedCases.push({
      caseSourceId: customer.id,
      sourceIds: [customer, ...ownShares].map((row) => row.id),
      caseId: current?.id ?? null,
      action,
      existing: current ? caseRecord(current) : null,
      proposed,
      existingSnapshotHash: current?.snapshotHash ?? null,
      proposedSnapshotHash: reconciliationHash(caseSnapshot),
    });
    if (project.collectionMode === 'PARTNER') {
      const external = externalInput(data, customer),
        existing = refs.find((ref) => ref.externalId === customer.id);
      let referenceAction: ImportPreview['proposedReferences'][number]['action'] = existing
        ? 'REUSE'
        : 'CREATE';
      if (
        existing &&
        (existing.projectId !== projectId ||
          existing.caseId !== current?.id ||
          object(metadata(existing.sourceSnapshot).project).id !== data.payload.project.id ||
          (!sameFacts(metadata(existing.sourceSnapshot).proposed, external) &&
            !sameFacts(invoiceRecord(existing).external, external)))
      ) {
        referenceAction = 'REVISION';
        issue(
          'IMPORT_SOURCE_REVISION',
          'Existing external reference differs from proposed source facts. Review through explicit reference forms; import will not overwrite.',
          [customer.id],
          customer.id,
        );
      }
      const duplicateIds = await duplicateInvoiceIds(tx, companyId, external, existing?.id);
      if (duplicateIds.length && !existing)
        issue(
          'DUPLICATE_INVOICE_REVIEW_REQUIRED',
          `Existing issuer/number/year references require explicit manual identity review: ${duplicateIds.join(', ')}`,
          [customer.id],
          customer.id,
        );
      preview.proposedReferences.push({
        sourceId: customer.id,
        caseSourceId: customer.id,
        referenceId: existing?.id ?? null,
        action: referenceAction,
        existing: existing ? invoiceRecord(existing) : null,
        proposed: external,
        proposedSnapshotHash: reconciliationHash({
          ...external,
          ledgerlyImportV1: { project: data.payload.project, row: customer, proposed: external },
        }),
      });
    }
  }
  const selectedSources = new Set<string>(),
    selectedDocuments = new Set<string>();
  for (const selection of data.selectedMatches) {
    if (selectedSources.has(selection.sourceId) || selectedDocuments.has(selection.documentId))
      issue(
        'IMPORT_INVALID_SELECTION',
        'A source row and own document may each be selected only once.',
        [selection.sourceId],
        selection.caseSourceId,
      );
    selectedSources.add(selection.sourceId);
    selectedDocuments.add(selection.documentId);
    const row = data.payload.invoices.find((row) => row.id === selection.sourceId);
    if (!row || !linkRole(project, row) || sourceCase.get(selection.sourceId) !== selection.caseSourceId)
      issue(
        'IMPORT_INVALID_SELECTION',
        'Selection must bind an eligible source row to its exact historical customer anchor.',
        [selection.sourceId],
        selection.caseSourceId,
      );
  }
  for (const row of data.payload.invoices) {
    const role = linkRole(project, row),
      anchor = sourceCase.get(row.id);
    if (!role || !anchor || !usable.has(row.id)) continue;
    const typeId = linkType(role),
      currentCase = cases.find((value) => value.externalId === anchor && value.projectId === projectId);
    const selection = data.selectedMatches.find((value) => value.sourceId === row.id) ?? null;
    const currentLinks = links.filter(
      (link) => link.projectId === projectId && link.caseId === currentCase?.id && link.role === role,
    );
    const existing = currentLinks.length === 1 ? currentLinks[0] : null;
    const eligible = documents.filter(
      (doc) =>
        documentMatchesRole(project, { role, typeId, caseId: currentCase?.id ?? anchor }, doc) &&
        (doc.displayNumber === row.number ||
          doc.id === selection?.documentId ||
          doc.id === existing?.documentId) &&
        financial.get(`${doc.typeId}:${doc.id}`)?.currency === project.currency,
    );
    const candidates = eligible.map((doc) => ({
      documentId: doc.id,
      typeId: doc.typeId as LinkDocumentInput['typeId'],
      basis:
        doc.displayNumber === row.number
          ? ('CONTEXTUAL_REFERENCE' as const)
          : ('EXPLICIT_SELECTION' as const),
      financial: financial.get(`${doc.typeId}:${doc.id}`)!,
    }));
    let existingLinkId: string | null = null,
      action: ImportPreview['proposedLinks'][number]['action'] = 'UNRESOLVED';
    const chosen = selection?.documentId ?? existing?.documentId;
    if (selection) {
      try {
        await validateDocumentLinkTx(core, tx, project, {
          documentId: selection.documentId,
          typeId: selection.typeId,
          caseId: currentCase?.id ?? anchor,
          role,
        });
        if (selection.typeId !== typeId) throw new Error('Source kind requires another document type');
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        issue(
          'IMPORT_INVALID_SELECTION',
          'Selected own document failed company, type, role, recipient or currency validation.',
          [row.id],
          anchor,
        );
      }
    }
    if (chosen) {
      const link = links.find((link) => link.documentId === chosen);
      if (link && (link.projectId !== projectId || link.caseId !== currentCase?.id || link.role !== role))
        issue(
          'DOCUMENT_ALREADY_LINKED',
          'Selected document belongs to another project, case or role.',
          [row.id],
          anchor,
        );
      else if (existing && existing.documentId !== chosen)
        issue(
          'IMPORT_SOURCE_REVISION',
          'Changing an existing source document match requires explicit unlink/review.',
          [row.id],
          anchor,
        );
      else if (link) {
        existingLinkId = link.id;
        action = 'REUSE';
      } else if (selection) action = 'CREATE';
      if (!candidates.some((candidate) => candidate.documentId === chosen))
        issue(
          'IMPORT_INVALID_SELECTION',
          'Selected or existing own document no longer matches the required context.',
          [row.id],
          anchor,
        );
    }
    if (action === 'UNRESOLVED')
      issue(
        'IMPORT_OWN_LINK_MISSING',
        'No own document selected; valid historical facts can import and the required link stays open.',
        [row.id],
        anchor,
        false,
        true,
      );
    preview.proposedLinks.push({
      sourceId: row.id,
      caseSourceId: anchor,
      role,
      historical: externalInput(data, row),
      candidates,
      selectedMatch: selection,
      existingLinkId,
      action,
    });
  }
  preview.counts = {
    sourceRows: data.payload.invoices.length,
    casesToCreate: preview.proposedCases.filter((item) => item.action === 'CREATE').length,
    referencesToCreate: preview.proposedReferences.filter((item) => item.action === 'CREATE').length,
    linksToCreate: preview.proposedLinks.filter((item) => item.action === 'CREATE').length,
    reused: [...preview.proposedCases, ...preview.proposedReferences, ...preview.proposedLinks].filter(
      (item) => item.action === 'REUSE',
    ).length,
    revisions: [...preview.proposedCases, ...preview.proposedReferences].filter(
      (item) => item.action === 'REVISION',
    ).length,
    unresolved: preview.unresolved.length,
    errors: preview.errors.length,
  };
  preview.previewHash = reconciliationHash({
    companyId,
    projectId,
    company,
    parties,
    project,
    data,
    preview,
    cases,
    refs,
    links,
    documents: documents.map((doc) => ({
      id: doc.id,
      typeId: doc.typeId,
      displayNumber: doc.displayNumber,
      data: doc.data,
      sourceVersion: financial.get(`${doc.typeId}:${doc.id}`)?.sourceVersion,
    })),
  });
  return parse(schemas.importPreview, preview);
}
export async function previewImport(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: unknown,
): Promise<ImportPreview> {
  assertImportSize(input);
  const data = normalize(parse(schemas.importPreviewInput, input));
  return core.db.$transaction(
    async (tx) => {
      const project = await tx.reconciliationProject.findFirst({ where: { companyId, id: projectId } });
      if (!project) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
      return loadPlan(core, tx, project, data);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
export async function confirmImport(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: unknown,
  context: MutationContext,
) {
  assertImportSize({
    ...object(input),
    requestKey: context.requestKey,
    expectedVersion: context.expectedVersion,
  });
  const data = normalize(parse(schemas.importConfirm, input));
  return core.mutate(
    companyId,
    projectId,
    data,
    context,
    'import.confirm',
    `project:${projectId}:import`,
    async (tx, project) => {
      const { previewHash: _hash, ...previewInput } = data;
      const preview = await loadPlan(core, tx, project!, previewInput);
      if (preview.previewHash !== data.previewHash)
        reconciliationConflict(
          'Import source or candidate financial facts changed. Preview again.',
          'IMPORT_PREVIEW_STALE',
        );
      if ([...preview.errors, ...preview.unresolved].some((issue) => issue.blocking))
        reconciliationConflict(
          'Import contains blocking source revisions or unresolved rows. Review and preview again.',
          'IMPORT_REVIEW_REQUIRED',
        );
      const result: ImportApplied = {
        previewHash: preview.previewHash,
        sourceHash: preview.sourceHash,
        sourceAsOf: preview.sourceAsOf,
        cases: [],
        references: [],
        links: [],
        unresolved: preview.unresolved,
        counts: preview.counts,
      };
      for (const item of preview.proposedCases) {
        const caseId: string = item.caseId ?? (await core.createCaseTx(tx, project!, item.proposed)).id;
        if (!item.caseId) {
          const rows = data.payload.invoices.filter((row) => item.sourceIds.includes(row.id));
          const sourceSnapshot = json({
            sourceSystem: 'ledgerly',
            sourceId: item.caseSourceId,
            sourceAsOf: data.payload.sourceAsOf,
            ledgerlyImportV1: { project: data.payload.project, rows, proposed: item.proposed },
          });
          await tx.reconciliationCase.update({
            where: { id: caseId },
            data: {
              source: 'ledgerly',
              externalId: item.caseSourceId,
              sourceSnapshot,
              snapshotHash: reconciliationHash(sourceSnapshot),
            },
          });
        }
        result.cases.push({ caseSourceId: item.caseSourceId, caseId, created: item.action === 'CREATE' });
      }
      for (const item of preview.proposedReferences) {
        let referenceId = item.referenceId;
        if (!referenceId) {
          const caseId = result.cases.find((value) => value.caseSourceId === item.caseSourceId)!.caseId;
          const row = data.payload.invoices.find((row) => row.id === item.sourceId)!;
          referenceId = (
            await saveExternalInvoiceTx(
              tx,
              project!,
              caseId,
              item.proposed,
              undefined,
              json({ project: data.payload.project, row, proposed: item.proposed }),
            )
          ).result.id;
        }
        result.references.push({ sourceId: item.sourceId, referenceId, created: item.action === 'CREATE' });
      }
      for (const item of preview.proposedLinks) {
        let linkId = item.existingLinkId;
        if (item.action === 'CREATE' && item.selectedMatch) {
          const caseId = result.cases.find((value) => value.caseSourceId === item.caseSourceId)!.caseId;
          linkId = (
            await createDocumentLinkTx(core, tx, project!, {
              documentId: item.selectedMatch.documentId,
              typeId: item.selectedMatch.typeId,
              role: item.role,
              caseId,
            })
          ).id;
        }
        if (linkId) result.links.push({ sourceId: item.sourceId, linkId, created: item.action === 'CREATE' });
      }
      return {
        result: parse(schemas.importApplied, result),
        projectId,
        before: { preview, payload: data.payload, selectedMatches: data.selectedMatches },
      };
    },
    undefined,
    async (tx, project) => {
      const documents = await candidateDocuments(tx, project, data);
      // Lock unrelated notes too: an existing note can retarget data.invoice without an FK lock.
      const credits = documents.some((doc) => doc.typeId === 'invoice')
        ? await tx.documentInstance.findMany({
            where: { companyId, typeId: 'credit-note' },
            select: { id: true },
          })
        : [];
      return [...documents, ...credits].map((doc) => doc.id);
    },
    { exclusiveCompany: true, staleCode: 'IMPORT_PREVIEW_STALE' },
  );
}
