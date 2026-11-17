import type { Prisma } from '../../../prisma/generated/prisma/client';

/** Only the authorised permanent-company deletion paths call this, inside their transaction. */
export async function purgeReconciliationForCompany(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  // Block new company-owned references until the enclosing company deletion commits.
  await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
  const where = { companyId };
  await tx.externalReceiptAllocation.deleteMany({ where });
  await tx.customerInvoiceReference.deleteMany({ where });
  await tx.externalReceipt.deleteMany({ where });
  await tx.projectDocumentLink.deleteMany({ where });
  await tx.reconciliationAuditEvent.deleteMany({ where });
  await tx.reconciliationCase.deleteMany({ where });
  await tx.reconciliationProject.deleteMany({ where });
}

/** Company protection always precedes the aggregate lock, matching authorised company purge. */
export async function lockReconciliationCompany(
  tx: Prisma.TransactionClient,
  companyId: string,
  exclusive = false,
) {
  if (exclusive)
    return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
  return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Company" WHERE id = ${companyId} FOR KEY SHARE`;
}
export async function lockReconciliationProject(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
) {
  return tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "ReconciliationProject" WHERE "companyId" = ${companyId} AND id = ${projectId} FOR UPDATE`;
}
