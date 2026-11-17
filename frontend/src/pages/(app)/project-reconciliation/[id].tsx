import { useParams } from "react-router"
import { useTranslation } from "react-i18next"
import { useCompanies } from "@/hooks/queries/use-companies"
import { usePageHeader } from "@/hooks/use-page-header"
import { ProjectDetail } from "./_components/project-detail"
export default function ProjectDetailPage() {
  const { id } = useParams()
  const { activeCompanyId } = useCompanies()
  const { t } = useTranslation()
  usePageHeader(t("sidebar.navigation.projectReconciliation"))
  return activeCompanyId && id ? (
    <ProjectDetail key={`${activeCompanyId}:${id}`} companyId={activeCompanyId} projectId={id} />
  ) : null
}
