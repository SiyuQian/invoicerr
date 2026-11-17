import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DocumentFinancialRead } from '../documents/settlement/financial-read.service';
import type { Prisma, ReconciliationProject } from '../../../prisma/generated/prisma/client';
import type { ReconciliationService } from './service';
import { reconciliationConflict } from './service';
import { parse, schemas } from './validation';
import type { LinkDocumentInput, MutationContext, DocumentLinkRecord } from './types';

export function documentMatchesRole(
  project: ReconciliationProject,
  link: Pick<LinkDocumentInput, 'role' | 'caseId' | 'typeId'>,
  document: { typeId: string; data: unknown },
) {
  const facts =
    document.data && typeof document.data === 'object' && !Array.isArray(document.data)
      ? (document.data as Record<string, unknown>)
      : {};
  if (document.typeId !== link.typeId) return false;
  if (link.role === 'PROJECT_COST') return ['expense', 'received-invoice'].includes(document.typeId);
  if (link.role === 'CUSTOMER_INVOICE')
    return (
      project.collectionMode === 'COMPANY' &&
      link.caseId !== null &&
      !!project.endCustomerClientId &&
      document.typeId === 'invoice' &&
      facts.client === project.endCustomerClientId
    );
  if (link.role === 'SETTLEMENT_INCOME')
    return (
      project.collectionMode === 'PARTNER' &&
      document.typeId === 'invoice' &&
      facts.client === project.partnerClientId
    );
  return (
    project.collectionMode === 'COMPANY' &&
    !!project.partnerClientId &&
    document.typeId === 'received-invoice' &&
    facts.supplierClient === project.partnerClientId
  );
}

export async function validateDocumentLinkTx(
  core: ReconciliationService,
  tx: Prisma.TransactionClient,
  project: ReconciliationProject,
  data: LinkDocumentInput,
): Promise<DocumentFinancialRead> {
  const companyId = project.companyId;
  const document = await tx.documentInstance.findFirst({ where: { companyId, id: data.documentId } });
  if (!document) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document not found.' });
  if (!documentMatchesRole(project, data, document))
    reconciliationConflict('The document role, direction, type or linked party does not match the project.');
  let read: DocumentFinancialRead;
  try {
    read = (await core.financialRead.readMany(companyId, [{ id: document.id, typeId: data.typeId }], tx)).get(
      `${data.typeId}:${document.id}`,
    )!;
  } catch {
    throw new ServiceUnavailableException({
      code: 'FINANCIAL_READ_UNAVAILABLE',
      message: 'Canonical financial sources could not be read.',
    });
  }
  if (read.currency !== project.currency)
    reconciliationConflict('Document currency must match the project.', 'CURRENCY_MISMATCH');
  return read;
}
export async function createDocumentLinkTx(
  core: ReconciliationService,
  tx: Prisma.TransactionClient,
  project: ReconciliationProject,
  input: LinkDocumentInput,
): Promise<DocumentLinkRecord> {
  const data = parse(schemas.linkDocument, input);
  const companyId = project.companyId,
    projectId = project.id;
  if (!(await tx.documentInstance.findFirst({ where: { companyId, id: data.documentId } })))
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document not found.' });
  if (await tx.projectDocumentLink.findFirst({ where: { companyId, documentId: data.documentId } }))
    reconciliationConflict(
      'This document already belongs to a reconciliation project.',
      'DOCUMENT_ALREADY_LINKED',
    );
  if (
    data.caseId &&
    !(await tx.reconciliationCase.findFirst({ where: { companyId, projectId, id: data.caseId } }))
  )
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found.' });
  await validateDocumentLinkTx(core, tx, project, data);
  const row = await tx.projectDocumentLink.create({
    data: { companyId, projectId, documentId: data.documentId, caseId: data.caseId, role: data.role },
  });
  if (data.role === 'CUSTOMER_INVOICE')
    await tx.customerInvoiceReference.create({
      data: {
        companyId,
        projectId,
        caseId: data.caseId!,
        collectionMode: 'COMPANY',
        documentLinkId: row.id,
        documentLinkRole: 'CUSTOMER_INVOICE',
      },
    });
  return { id: row.id, ...data };
}

export async function linkDocument(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: LinkDocumentInput,
  context: MutationContext,
) {
  const data = parse(schemas.linkDocument, input);
  return core.mutate(
    companyId,
    projectId,
    data,
    context,
    'document.link',
    `document:${data.documentId}`,
    async (tx, project) => ({ result: await createDocumentLinkTx(core, tx, project!, data), projectId }),
    async (tx) => {
      if (
        !(await tx.documentInstance.findFirst({
          where: { companyId, id: data.documentId },
          select: { id: true },
        }))
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document not found.' });
      if (
        data.caseId &&
        !(await tx.reconciliationCase.findFirst({
          where: { companyId, projectId, id: data.caseId },
          select: { id: true },
        }))
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found.' });
    },
    [data.documentId],
  );
}

export async function unlinkDocument(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: { linkId: string; reason: string },
  context: MutationContext,
) {
  const { linkId, ...rest } = input;
  const data = { linkId: parse(schemas.recordId, { id: linkId }).id, ...parse(schemas.reason, rest) };
  return core.mutate(
    companyId,
    projectId,
    data,
    context,
    'document.unlink',
    `link:${data.linkId}`,
    async (tx) => {
      const row = await tx.projectDocumentLink.findFirstOrThrow({
        where: { companyId, projectId, id: data.linkId },
        include: { document: { select: { typeId: true } } },
      });
      await tx.customerInvoiceReference.deleteMany({
        where: { companyId, projectId, documentLinkId: row.id },
      });
      await tx.projectDocumentLink.delete({ where: { id: row.id } });
      const result: DocumentLinkRecord = {
        id: row.id,
        documentId: row.documentId,
        typeId: row.document.typeId as DocumentLinkRecord['typeId'],
        caseId: row.caseId,
        role: row.role,
      };
      return { result, projectId, before: result, auditReason: data.reason };
    },
    async (tx) => {
      if (
        !(await tx.projectDocumentLink.findFirst({
          where: { companyId, projectId, id: data.linkId },
          select: { id: true },
        }))
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document link not found.' });
    },
  );
}
