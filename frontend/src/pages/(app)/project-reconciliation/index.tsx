import { useTranslation } from "react-i18next"
import { useCompanies } from "@/hooks/queries/use-companies"
import { usePageHeader } from "@/hooks/use-page-header"
import { ProjectList } from "./_components/project-list"

export default function ProjectReconciliationPage() {
  const { t } = useTranslation()
  const { activeCompanyId } = useCompanies()
  usePageHeader(t("sidebar.navigation.projectReconciliation"))
  return activeCompanyId ? <ProjectList key={activeCompanyId} companyId={activeCompanyId} /> : null
}
