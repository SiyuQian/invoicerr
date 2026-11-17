import { ApiError, useApiMutation, useApiQuery } from "@/hooks/use-api-query"
import { queryKeys } from "@/lib/query-keys"
import type { Client, Project } from "@/types"
import type {
  CreateProjectInput,
  MutationBody,
  MutationResult,
  ProjectListPage,
  ProjectListQuery,
  ProjectRecord,
  ProjectView,
  UpdateProjectInput,
} from "@/types/project-reconciliation"
import { useCompanies } from "./use-companies"

const base = "/api/project-reconciliation/projects"
export function useReconciliationProjects(filters: ProjectListQuery = {}) {
  const { activeCompanyId } = useCompanies()
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, value)
  if (!filters.limit) params.set("limit", "25")
  return useApiQuery<ProjectListPage>(
    queryKeys.projectReconciliation.projects(activeCompanyId, filters),
    `${base}?${params}`,
    { enabled: !!activeCompanyId, placeholderData: undefined },
  )
}
export function useReconciliationProject(id: string, filters: ReportQuery = {}) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<ProjectView>(
    queryKeys.projectReconciliation.project(activeCompanyId, id, filters),
    `${base}/${encodeURIComponent(id)}?${readParams(filters)}`,
    {
      enabled: !!activeCompanyId && !!id,
      placeholderData: undefined,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  )
}
export function useReconciliationClients(search: string, enabled: boolean) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<Client[]>(
    queryKeys.projectReconciliation.clients(activeCompanyId, search),
    `/api/clients/search?query=${encodeURIComponent(search)}`,
    { enabled: enabled && !!activeCompanyId, placeholderData: undefined },
  )
}
export function useReconciliationTimeProjects(enabled: boolean) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<Project[]>(
    queryKeys.projectReconciliation.timeProjects(activeCompanyId),
    "/api/projects",
    { enabled: enabled && !!activeCompanyId, placeholderData: undefined },
  )
}
function useWriteOptions(companyId: string) {
  const { activeCompanyId, activeRole } = useCompanies()
  return {
    invalidateKeys: [queryKeys.projectReconciliation.all(companyId)],
    onMutate: () => {
      if (!companyId || activeCompanyId !== companyId || (activeRole !== "OWNER" && activeRole !== "ADMIN"))
        throw new ApiError(403, "RECONCILIATION_FORBIDDEN")
    },
  }
}
export function useCreateReconciliationProject(companyId: string) {
  return useApiMutation<MutationBody<CreateProjectInput>, MutationResult<ProjectRecord>>(
    "POST",
    base,
    useWriteOptions(companyId),
  )
}
export function useUpdateReconciliationProject(companyId: string, projectId: string) {
  return useApiMutation<MutationBody<UpdateProjectInput>, MutationResult<ProjectRecord>>(
    "PATCH",
    `${base}/${encodeURIComponent(projectId)}`,
    useWriteOptions(companyId),
  )
}

import type {
  CaseRecord,
  CreateCaseInput,
  UpdateCaseInput,
  ExternalInvoiceInput,
  UpdateExternalInvoiceInput,
  ExternalInvoiceRecord,
  CreditAdjustmentInput,
  ReceiptInput,
  UpdateReceiptInput,
  ReceiptRecord,
  ReasonInput,
  LinkDocumentInput,
  DocumentLinkRecord,
  EvidenceCoverageInput,
  CoverageResult,
  ReviewCaseInput,
  ReviewResult,
} from "@/types/project-reconciliation"

export function useCreateReconciliationCase(companyId: string, projectId: string) {
  return useApiMutation<MutationBody<CreateCaseInput>, MutationResult<CaseRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/cases`,
    useWriteOptions(companyId),
  )
}

export function useUpdateReconciliationCase(companyId: string, projectId: string, caseId: string) {
  return useApiMutation<MutationBody<UpdateCaseInput>, MutationResult<CaseRecord>>(
    "PATCH",
    `${base}/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}`,
    useWriteOptions(companyId),
  )
}

export function useCreateExternalInvoice(companyId: string, projectId: string, caseId: string) {
  return useApiMutation<MutationBody<ExternalInvoiceInput>, MutationResult<ExternalInvoiceRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}/customer-invoices`,
    useWriteOptions(companyId),
  )
}

export function useUpdateExternalInvoice(
  companyId: string,
  projectId: string,
  caseId: string,
  invoiceId: string,
) {
  return useApiMutation<MutationBody<UpdateExternalInvoiceInput>, MutationResult<ExternalInvoiceRecord>>(
    "PATCH",
    `${base}/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}/customer-invoices/${encodeURIComponent(invoiceId)}`,
    useWriteOptions(companyId),
  )
}

export function useExternalCreditAdjustment(companyId: string, projectId: string, invoiceId: string) {
  return useApiMutation<MutationBody<CreditAdjustmentInput>, MutationResult<ExternalInvoiceRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/customer-invoices/${encodeURIComponent(invoiceId)}/credit-adjustments`,
    useWriteOptions(companyId),
  )
}

export function useCreateExternalReceipt(companyId: string, projectId: string) {
  return useApiMutation<MutationBody<ReceiptInput>, MutationResult<ReceiptRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/receipts`,
    useWriteOptions(companyId),
  )
}

export function useUpdateExternalReceipt(companyId: string, projectId: string, receiptId: string) {
  return useApiMutation<MutationBody<UpdateReceiptInput>, MutationResult<ReceiptRecord>>(
    "PATCH",
    `${base}/${encodeURIComponent(projectId)}/receipts/${encodeURIComponent(receiptId)}`,
    useWriteOptions(companyId),
  )
}

export function useVoidExternalReceipt(companyId: string, projectId: string, receiptId: string) {
  return useApiMutation<MutationBody<ReasonInput>, MutationResult<ReceiptRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/receipts/${encodeURIComponent(receiptId)}/void`,
    useWriteOptions(companyId),
  )
}

export function useLinkReconciliationDocument(companyId: string, projectId: string) {
  return useApiMutation<MutationBody<LinkDocumentInput>, MutationResult<DocumentLinkRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/document-links`,
    useWriteOptions(companyId),
  )
}

export function useUnlinkReconciliationDocument(companyId: string, projectId: string, linkId: string) {
  return useApiMutation<MutationBody<ReasonInput>, MutationResult<DocumentLinkRecord>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/document-links/${encodeURIComponent(linkId)}/unlink`,
    useWriteOptions(companyId),
  )
}

export function useAttestReconciliationCoverage(companyId: string, projectId: string) {
  return useApiMutation<MutationBody<EvidenceCoverageInput>, MutationResult<CoverageResult>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/evidence-coverage`,
    useWriteOptions(companyId),
  )
}

export function useReviewReconciliationCase(companyId: string, projectId: string, caseId: string) {
  return useApiMutation<MutationBody<ReviewCaseInput>, MutationResult<ReviewResult>>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}/review`,
    useWriteOptions(companyId),
  )
}

import type { DocumentInstancesPage } from "./use-document-types"
export function useReconciliationDocumentCandidates(
  typeId: string,
  search: string,
  page: number,
  enabled: boolean,
) {
  const { activeCompanyId } = useCompanies()
  const params = new URLSearchParams({ typeId, q: search, page: String(page), pageSize: "25" })
  return useApiQuery<DocumentInstancesPage>(
    queryKeys.projectReconciliation.documents(activeCompanyId, typeId, search, page),
    `/api/documents?${params}`,
    { enabled: enabled && !!activeCompanyId, placeholderData: undefined },
  )
}

import { useMutation } from "@tanstack/react-query"
import { authenticatedFetch } from "@/hooks/use-fetch"
import type {
  ReportQuery,
  PageQuery,
  InvoiceChoiceQuery,
  ReceiptPage,
  ReceiptQuery,
  ExternalInvoicePage,
  HistoryPage,
  AllocationsInput,
  ReceiptAllocationsRecord,
  ExportQuery,
} from "@/types/project-reconciliation"
function readParams(filters: object, paged = true) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, String(value))
  if (paged && !params.has("limit")) params.set("limit", "25")
  return params
}
export function useReconciliationReceipts(projectId: string, filters: ReceiptQuery = {}) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<ReceiptPage>(
    queryKeys.projectReconciliation.child(activeCompanyId, projectId, "receipts", filters),
    `${base}/${encodeURIComponent(projectId)}/receipts?${readParams(filters)}`,
    {
      enabled: !!activeCompanyId && !!projectId,
      placeholderData: undefined,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  )
}
export function useReconciliationInvoiceChoices(projectId: string, filters: InvoiceChoiceQuery = {}) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<ExternalInvoicePage>(
    queryKeys.projectReconciliation.child(activeCompanyId, projectId, "customer-invoices", filters),
    `${base}/${encodeURIComponent(projectId)}/customer-invoices?${readParams(filters)}`,
    { enabled: !!activeCompanyId && !!projectId, placeholderData: undefined },
  )
}
export function useReconciliationHistory(projectId: string, filters: PageQuery = {}) {
  const { activeCompanyId } = useCompanies()
  return useApiQuery<HistoryPage>(
    queryKeys.projectReconciliation.child(activeCompanyId, projectId, "history", filters),
    `${base}/${encodeURIComponent(projectId)}/history?${readParams(filters)}`,
    { enabled: !!activeCompanyId && !!projectId, placeholderData: undefined },
  )
}
export function useReplaceReceiptAllocations(companyId: string, projectId: string, receiptId: string) {
  return useApiMutation<MutationBody<AllocationsInput>, MutationResult<ReceiptAllocationsRecord>>(
    "PUT",
    `${base}/${encodeURIComponent(projectId)}/receipts/${encodeURIComponent(receiptId)}/allocations`,
    useWriteOptions(companyId),
  )
}
export function useExportReconciliationCsv(companyId: string, projectId: string, filters: ExportQuery) {
  const { activeCompanyId } = useCompanies()
  return useMutation<Blob, ApiError, void>({
    mutationFn: async () => {
      if (!companyId || companyId !== activeCompanyId) throw new ApiError(403, "RECONCILIATION_FORBIDDEN")
      const res = await authenticatedFetch(
        `${import.meta.env.VITE_BACKEND_URL || ""}${base}/${encodeURIComponent(projectId)}/export.csv?${readParams(filters, false)}`,
      )
      if (!res.ok) {
        const body = await res.json().catch(() => undefined)
        throw new ApiError(res.status, body?.message ?? "CSV export failed", body)
      }
      return res.blob()
    },
  })
}

import type {
  ImportPreviewInput,
  ImportPreview,
  ImportConfirmBody,
  ImportResult,
} from "@/types/project-reconciliation"
export function usePreviewReconciliationImport(companyId: string, projectId: string) {
  const { invalidateKeys: _invalidateKeys, ...guard } = useWriteOptions(companyId)
  return useApiMutation<ImportPreviewInput, ImportPreview>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/import/preview`,
    guard,
  )
}
export function useConfirmReconciliationImport(companyId: string, projectId: string) {
  return useApiMutation<ImportConfirmBody, ImportResult>(
    "POST",
    `${base}/${encodeURIComponent(projectId)}/import/confirm`,
    useWriteOptions(companyId),
  )
}
