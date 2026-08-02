import { defineLink } from "@medusajs/framework/utils"
import ProductModule from "@medusajs/medusa/product"
import DigitalDownloadsModule from "../modules/digital-downloads"

/**
 * A Medusa variant has at most one digital configuration. A digital product is
 * intentionally linked instead of storing a variant ID in the module table so
 * Query, remote links, and deletion semantics remain native to Medusa.
 */
export default defineLink(
  {
    linkable: ProductModule.linkable.productVariant,
    isList: true,
  },
  {
    linkable: DigitalDownloadsModule.linkable.digitalProduct,
    isList: false,
  }
)
