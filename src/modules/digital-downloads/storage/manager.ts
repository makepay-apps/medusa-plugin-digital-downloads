import {
  DigitalStorageProvider,
  type ResolvedDigitalDownloadsModuleOptions,
} from "../types"
import { ProtectedLocalStorageDriver } from "./local-driver"
import { S3CompatibleStorageDriver } from "./s3-driver"
import type {
  StorageDriver,
  StorageObjectLocator,
  StoragePutInput,
  StoragePutStreamInput,
  StorageReadInput,
} from "./types"

export class DigitalDownloadsStorageManager {
  readonly defaultProvider: DigitalStorageProvider
  private readonly drivers = new Map<DigitalStorageProvider, StorageDriver>()

  constructor(options: ResolvedDigitalDownloadsModuleOptions) {
    this.defaultProvider = options.storage.defaultProvider
    this.drivers.set(
      DigitalStorageProvider.LOCAL,
      new ProtectedLocalStorageDriver(options.storage.local),
    )
    if (options.storage.s3) {
      this.drivers.set(
        DigitalStorageProvider.S3,
        new S3CompatibleStorageDriver(options.storage.s3),
      )
    }
  }

  driver(provider = this.defaultProvider): StorageDriver {
    const driver = this.drivers.get(provider)
    if (!driver) {
      throw new Error(`Storage provider ${provider} is not configured`)
    }
    return driver
  }

  put(input: StoragePutInput & { provider?: DigitalStorageProvider }) {
    return this.driver(input.provider).put(input)
  }

  putStream(
    input: StoragePutStreamInput & { provider?: DigitalStorageProvider },
  ) {
    const driver = this.driver(input.provider)
    if (!driver.putStream) {
      throw new Error(`Storage provider ${driver.provider} does not accept streamed uploads`)
    }
    return driver.putStream(input)
  }

  get(input: StorageReadInput & { provider: DigitalStorageProvider }) {
    return this.driver(input.provider).get(input)
  }

  delete(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ) {
    return this.driver(locator.provider).delete(locator)
  }

  exists(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ) {
    return this.driver(locator.provider).exists(locator)
  }

  inspect(locator: StorageObjectLocator & { provider: DigitalStorageProvider }) {
    const driver = this.driver(locator.provider)
    if (!driver.inspect) {
      throw new Error(`Storage provider ${driver.provider} does not support metadata inspection`)
    }
    return driver.inspect(locator)
  }

  computeChecksum(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ) {
    const driver = this.driver(locator.provider)
    if (!driver.computeChecksum) {
      throw new Error(`Storage provider ${driver.provider} cannot stream checksums`)
    }
    return driver.computeChecksum(locator)
  }

  createUploadDescriptor(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ) {
    const driver = this.driver(locator.provider)
    if (!driver.createUploadDescriptor) {
      throw new Error(`Storage provider ${driver.provider} does not support direct upload URLs`)
    }
    return driver.createUploadDescriptor(locator, input, expiresInSeconds)
  }

  destroy(): void {
    for (const driver of this.drivers.values()) {
      driver.destroy?.()
    }
  }
}
