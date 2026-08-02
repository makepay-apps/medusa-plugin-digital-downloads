import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@medusajs/ui"
import { useNavigate, useSearchParams } from "react-router-dom"

import { PageHeader } from "../../../components/page-header"
import { ProductConfigForm } from "../../../components/product-config-form"
import { getErrorMessage } from "../../../lib/format"
import { digitalDownloadKeys } from "../../../lib/query-keys"
import { digitalDownloadsApi } from "../../../lib/sdk"
import type { ProductConfigInput } from "../../../types/digital-downloads"

const CreateDigitalDownloadPage = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const createMutation = useMutation({
    mutationFn: (input: ProductConfigInput) =>
      digitalDownloadsApi.createProductConfig(input),
    onSuccess: async (created) => {
      toast.success("Digital product configuration created.")
      await queryClient.invalidateQueries({ queryKey: digitalDownloadKeys.all })
      navigate(`/digital-downloads/${created.id}`)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  })

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        description="Associate variants, choose delivery behavior, then add your first release."
        onBack={() => navigate("/digital-downloads")}
        title="Create digital product"
      />
      <ProductConfigForm
        defaultProductId={searchParams.get("product_id") ?? undefined}
        isSubmitting={createMutation.isPending}
        onCancel={() => navigate("/digital-downloads")}
        onSubmit={async (input) => {
          await createMutation.mutateAsync(input)
        }}
        submitLabel="Create and add release"
      />
    </div>
  )
}

export default CreateDigitalDownloadPage
