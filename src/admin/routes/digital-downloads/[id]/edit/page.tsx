import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@medusajs/ui"
import { useNavigate, useParams } from "react-router-dom"

import { ErrorState, LoadingState } from "../../../../components/feedback-state"
import { PageHeader } from "../../../../components/page-header"
import { ProductConfigForm } from "../../../../components/product-config-form"
import { getErrorMessage } from "../../../../lib/format"
import { digitalDownloadKeys } from "../../../../lib/query-keys"
import { digitalDownloadsApi } from "../../../../lib/sdk"
import type { ProductConfigInput } from "../../../../types/digital-downloads"

const EditDigitalDownloadPage = () => {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: digitalDownloadKeys.config(id),
    queryFn: () => digitalDownloadsApi.getProductConfig(id),
    enabled: Boolean(id),
  })
  const updateMutation = useMutation({
    mutationFn: (input: ProductConfigInput) =>
      digitalDownloadsApi.updateProductConfig(id, input),
    onSuccess: async () => {
      toast.success("Digital product configuration updated.")
      await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
      navigate(`/digital-downloads/${id}`)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  if (configQuery.isLoading) {
    return <LoadingState rows={8} />
  }

  if (configQuery.isError || !configQuery.data) {
    return (
      <ErrorState
        message={getErrorMessage(configQuery.error ?? "Configuration not found.")}
        onRetry={() => void configQuery.refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        description="Update delivery, access, and variant associations."
        onBack={() => navigate(`/digital-downloads/${id}`)}
        title={`Edit ${configQuery.data.title}`}
      />
      <ProductConfigForm
        initial={configQuery.data}
        isSubmitting={updateMutation.isPending}
        onCancel={() => navigate(`/digital-downloads/${id}`)}
        onSubmit={async (input) => {
          await updateMutation.mutateAsync(input)
        }}
        submitLabel="Save changes"
      />
    </div>
  )
}

export default EditDigitalDownloadPage
