import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { BlobServiceClient } from '../src/blob-service-client'
import { DefaultAzureCredential } from '../src/default-azure-credential'
import type { TableClient } from '../src/table-client'
import { TableServiceClient } from '../src/table-service-client'
import { collect } from './helpers'

const env = process.env
const developmentStorage =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;'
const connectionString =
  env['AZUREFETCH_STORAGE_CONNECTION_STRING'] === 'UseDevelopmentStorage=true'
    ? developmentStorage
    : env['AZUREFETCH_STORAGE_CONNECTION_STRING']
const accountName = env['AZUREFETCH_STORAGE_ACCOUNT_NAME']
const endpointSuffix = env['AZUREFETCH_STORAGE_ENDPOINT_SUFFIX'] ?? 'core.windows.net'
const authMode =
  env['AZUREFETCH_STORAGE_AUTH_MODE'] ??
  (connectionString === undefined ? 'service-principal' : 'connection-string')
const configured =
  authMode === 'connection-string'
    ? connectionString !== undefined
    : [
        accountName,
        env['AZURE_TENANT_ID'],
        env['AZURE_CLIENT_ID'],
        env['AZURE_CLIENT_SECRET'],
      ].every((value) => value !== undefined && value !== '')

/** Clients are also built when the suite is skipped, so every value has a harmless fallback. */
function createClients(): { blobService: BlobServiceClient; tableService: TableServiceClient } {
  if (authMode === 'connection-string') {
    return {
      blobService: BlobServiceClient.fromConnectionString(connectionString ?? developmentStorage),
      tableService: TableServiceClient.fromConnectionString(connectionString ?? developmentStorage),
    }
  }

  const credential = new DefaultAzureCredential()
  const account = accountName ?? 'unconfigured'
  return {
    blobService: new BlobServiceClient(
      env['AZUREFETCH_STORAGE_BLOB_ENDPOINT'] ?? `https://${account}.blob.${endpointSuffix}`,
      credential,
    ),
    tableService: new TableServiceClient(
      env['AZUREFETCH_STORAGE_TABLE_ENDPOINT'] ?? `https://${account}.table.${endpointSuffix}`,
      credential,
    ),
  }
}

describe.runIf(env['AZUREFETCH_RUN_STORAGE_TESTS'] === '1' && configured)(
  'storage integration (manual)',
  () => {
    const { blobService, tableService } = createClients()

    describe('blob operations', () => {
      describe('container lifecycle', () => {
        const containerPrefix = `azfetch-blob-${randomToken()}`
        const firstContainerName = `${containerPrefix}-1`
        const secondContainerName = `${containerPrefix}-2`
        const firstContainer = blobService.getContainerClient(firstContainerName)
        const secondContainer = blobService.getContainerClient(secondContainerName)

        afterAll(async () => {
          await secondContainer.deleteIfExists()
          await firstContainer.deleteIfExists()
        })

        test('createIfNotExists creates both containers', async () => {
          await expect(firstContainer.createIfNotExists()).resolves.toStrictEqual({
            succeeded: true,
          })
          await expect(secondContainer.createIfNotExists()).resolves.toStrictEqual({
            succeeded: true,
          })
        })

        test('listContainers paginates with maxPageSize=1', async () => {
          const listed: string[] = []
          for await (const page of blobService.listContainers().byPage({ maxPageSize: 1 })) {
            listed.push(...page.segment.containerItems.map((item) => item.name))
          }

          expect(listed).toContain(firstContainerName)
          expect(listed).toContain(secondContainerName)
        })
      })

      describe('block blob lifecycle', () => {
        const container = blobService.getContainerClient(`azfetch-blob-${randomToken()}`)
        const blobName = 'folder/hello.txt'
        const secondBlobName = 'folder/world.txt'
        const blob = container.getBlockBlobClient(blobName)

        beforeAll(async () => {
          await container.createIfNotExists()
        })

        afterAll(async () => {
          await container.deleteIfExists()
        })

        test('upload stores the blob contents', async () => {
          const response = await blob.upload('hello')

          expect(response.status).toBe(201)
          await expect((await blob.download(1, 3)).text()).resolves.toBe('ell')
        })

        test('getProperties returns an etag', async () => {
          const properties = await blob.getProperties()

          expect(properties.etag).toBeTruthy()
        })

        test('listBlobsFlat paginates uploaded blob names', async () => {
          await container.getBlockBlobClient(secondBlobName).upload('world')

          const blobNames: string[] = []
          for await (const page of container.listBlobsFlat().byPage({ maxPageSize: 1 })) {
            blobNames.push(...page.segment.blobItems.map((item) => item.name))
          }

          expect(blobNames).toStrictEqual([blobName, secondBlobName])
        })

        test('deleteIfExists reports deleted and missing blobs', async () => {
          await expect(blob.deleteIfExists()).resolves.toStrictEqual({ succeeded: true })
          await expect(blob.deleteIfExists()).resolves.toStrictEqual({
            succeeded: false,
            errorCode: 'BlobNotFound',
          })
        })
      })

      describe('container helpers', () => {
        const container = blobService.getContainerClient(`azfetch-blob-${randomToken()}-helpers`)

        afterAll(async () => {
          await container.deleteIfExists()
        })

        test('deleteIfExists returns ContainerNotFound for a missing container', async () => {
          await expect(container.deleteIfExists()).resolves.toStrictEqual({
            succeeded: false,
            errorCode: 'ContainerNotFound',
          })
        })

        test('exists reflects whether the container was created', async () => {
          await expect(container.exists()).resolves.toBe(false)
          await container.createIfNotExists()
          await expect(container.exists()).resolves.toBe(true)
        })
      })

      test.runIf(authMode === 'connection-string')(
        'generateAccountSasUrl creates a usable signed URL',
        async () => {
          const sasUrl = await blobService.generateAccountSasUrl(
            new Date(Date.now() + 60 * 60 * 1000),
            { permissions: 'l', services: 'b', resourceTypes: 's', protocol: 'https,http' },
          )

          const pages = new BlobServiceClient(sasUrl).listContainers().byPage({ maxPageSize: 1 })
          await expect(pages[Symbol.asyncIterator]().next()).resolves.toMatchObject({
            done: false,
          })
        },
      )

      describe('blob batch', () => {
        const container = blobService.getContainerClient(`azfetch-blob-${randomToken()}-batch`)
        const blobs = ['delete-1.txt', 'delete-2.txt'].map((name) =>
          container.getBlockBlobClient(name),
        )

        beforeAll(async () => {
          await container.createIfNotExists()
          await Promise.all(blobs.map(async (blob) => await blob.upload('delete me')))
        })

        afterAll(async () => {
          await container.deleteIfExists()
        })

        test('deleteBlobs deletes both blobs', async () => {
          const response = await blobService
            .getBlobBatchClient()
            .deleteBlobs(blobs.map((blob) => blob.url))

          expect(response).toMatchObject({
            subResponses: [{ status: 202 }, { status: 202 }],
            subResponsesSucceededCount: 2,
            subResponsesFailedCount: 0,
          })
          for await (const page of container.listBlobsFlat().byPage()) {
            expect(page.segment.blobItems).toStrictEqual([])
          }
        })
      })
    })

    describe('table operations', () => {
      describe('table lifecycle', () => {
        const tableName = createTableName('lifecycle')
        const tableClient = tableService.getTableClient(tableName)

        afterAll(async () => {
          await tableService.deleteTableIfExists(tableName)
        })

        test('createTableIfNotExists creates a new table', async () => {
          const response = await tableService.createTableIfNotExists(tableName)

          expect(response.succeeded).toBe(true)
        })

        test('TableClient.createIfNotExists returns TableAlreadyExists for an existing table', async () => {
          const response = await tableClient.createIfNotExists()

          expect(response.succeeded).toBe(false)
          expect(response.errorCode).toBe('TableAlreadyExists')
        })

        test('TableClient.deleteIfExists returns succeeded=true for an existing table', async () => {
          const response = await tableClient.deleteIfExists()

          expect(response).toStrictEqual({ succeeded: true })
        })

        test('deleteTableIfExists returns TableNotFound for a missing table', async () => {
          const response = await tableService.deleteTableIfExists(tableName)

          expect(response).toStrictEqual({ succeeded: false, errorCode: 'TableNotFound' })
        })
      })

      describe('entity lifecycle', () => {
        const tableName = createTableName('entities')
        const tableClient = tableService.getTableClient(tableName)
        const rowsForCleanup: { partitionKey: string; rowKey: string }[] = []

        beforeAll(async () => {
          await tableService.createTableIfNotExists(tableName)
          await tableClient.upsertEntity({
            partitionKey: 'partition',
            rowKey: 'row-a',
            value: 'first',
          })
          await tableClient.upsertEntity({
            partitionKey: 'partition',
            rowKey: 'row-b',
            value: 'second',
          })
          rowsForCleanup.push(
            { partitionKey: 'partition', rowKey: 'row-a' },
            { partitionKey: 'partition', rowKey: 'row-b' },
          )
        })

        afterAll(async () => {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup)
          await tableService.deleteTableIfExists(tableName)
        })

        test('getEntity returns the written entity', async () => {
          const entity = await tableClient.getEntity('partition', 'row-a')

          expect(entity).toMatchObject({
            partitionKey: 'partition',
            rowKey: 'row-a',
            value: 'first',
          })
        })

        test('listEntities paginates with continuation tokens', async () => {
          const rowKeys: string[] = []
          const continuationTokens: (string | undefined)[] = []

          for await (const page of tableClient.listEntities().byPage({ maxPageSize: 1 })) {
            rowKeys.push(...page.value.map((entity) => entity.rowKey))
            continuationTokens.push(page.continuationToken)
          }

          expect(rowKeys).toHaveLength(2)
          expect(continuationTokens[0]).toBeTruthy()
          expect(continuationTokens.at(-1)).toBeUndefined()
        })

        test('getEntity returns undefined for a missing row', async () => {
          const missing = await tableClient.getEntity('missing', 'row')

          expect(missing).toBeUndefined()
        })

        test('deleteEntity returns succeeded=true for an existing row', async () => {
          const response = await tableClient.deleteEntity('partition', 'row-a')

          expect(response.succeeded).toBe(true)

          const deletedRowIndex = rowsForCleanup.findIndex((row) => row.rowKey === 'row-a')
          if (deletedRowIndex !== -1) {
            rowsForCleanup.splice(deletedRowIndex, 1)
          }
        })

        test('deleteEntity returns ResourceNotFound for a missing row', async () => {
          const response = await tableClient.deleteEntity('partition', 'row-a')

          expect(response).toStrictEqual({ succeeded: false, errorCode: 'ResourceNotFound' })
        })
      })

      test.runIf(authMode === 'connection-string')(
        'a table SAS URL reaches entities, queries and table deletion',
        async () => {
          const tableName = createTableName('sas')
          const accountSas = new URL(
            await blobService.generateAccountSasUrl(new Date(Date.now() + 60 * 60 * 1000), {
              permissions: 'rwdlacu',
              services: 't',
              resourceTypes: 'sco',
              protocol: 'https,http',
            }),
          ).search
          const sasService = new TableServiceClient(`${tableService.url}${accountSas}`)
          const sasTable = sasService.getTableClient(tableName)

          await sasTable.createIfNotExists()
          await sasTable.upsertEntity({ partitionKey: 'p', rowKey: 'r', value: 'inserted' })
          await sasTable.upsertEntity({ partitionKey: 'p', rowKey: 'r', value: 'replaced' })
          await expect(sasTable.getEntity('p', 'r')).resolves.toMatchObject({ value: 'replaced' })
          const pages = await collect(sasTable.listEntities().byPage())
          expect(pages.flatMap((page) => page.value)).toHaveLength(1)
          await expect(sasService.deleteTableIfExists(tableName)).resolves.toStrictEqual({
            succeeded: true,
          })
        },
      )

      describe('table batch', () => {
        const tableName = createTableName('batch')
        const tableClient = tableService.getTableClient(tableName)
        const rowsForCleanup: { partitionKey: string; rowKey: string }[] = []
        const batchedRows = [
          { partitionKey: 'batch-partition', rowKey: 'row-a', value: 'first' },
          { partitionKey: 'batch-partition', rowKey: 'row-b', value: 'second' },
        ] as const

        beforeAll(async () => {
          await tableService.createTableIfNotExists(tableName)
        })

        afterAll(async () => {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup)
          await tableService.deleteTableIfExists(tableName)
        })

        test('submitTransaction creates multiple rows', async () => {
          const response = await tableClient.submitTransaction(
            batchedRows.map((row) => ({
              action: 'create' as const,
              entity: row,
            })),
          )

          rowsForCleanup.push(
            ...batchedRows.map((row) => ({
              partitionKey: row.partitionKey,
              rowKey: row.rowKey,
            })),
          )

          expect(response.status).toBe(202)
          expect(response.subResponses).toHaveLength(2)
          for (const subResponse of response.subResponses) {
            expect([201, 204]).toContain(subResponse.status)
          }

          const firstRow = await tableClient.getEntity(
            batchedRows[0].partitionKey,
            batchedRows[0].rowKey,
          )
          const secondRow = await tableClient.getEntity(
            batchedRows[1].partitionKey,
            batchedRows[1].rowKey,
          )

          expect(firstRow).toMatchObject(batchedRows[0])
          expect(secondRow).toMatchObject(batchedRows[1])
        })

        test('submitTransaction rolls back every action when one create conflicts', async () => {
          const rolledBackRow = {
            partitionKey: batchedRows[0].partitionKey,
            rowKey: 'row-rolled-back',
            value: 'must-not-commit',
          }

          await expect(
            tableClient.submitTransaction([
              { action: 'create', entity: rolledBackRow },
              { action: 'create', entity: batchedRows[0] },
            ]),
          ).rejects.toThrow('Table transaction failed')

          await expect(
            tableClient.getEntity(rolledBackRow.partitionKey, rolledBackRow.rowKey),
          ).resolves.toBeUndefined()
          await expect(
            tableClient.getEntity(batchedRows[0].partitionKey, batchedRows[0].rowKey),
          ).resolves.toMatchObject(batchedRows[0])
        })

        test('submitTransaction deletes multiple rows', async () => {
          const response = await tableClient.submitTransaction(
            batchedRows.map((row) => ({
              action: 'delete' as const,
              partitionKey: row.partitionKey,
              rowKey: row.rowKey,
            })),
          )

          expect(response.status).toBe(202)
          expect(response.subResponses).toHaveLength(2)
          for (const subResponse of response.subResponses) {
            expect([202, 204]).toContain(subResponse.status)
          }

          rowsForCleanup.length = 0
          await expect(
            tableClient.getEntity(batchedRows[0].partitionKey, batchedRows[0].rowKey),
          ).resolves.toBeUndefined()
          await expect(
            tableClient.getEntity(batchedRows[1].partitionKey, batchedRows[1].rowKey),
          ).resolves.toBeUndefined()
        })
      })
    })
  },
)

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function createTableName(suffix: string): string {
  return `azfetchtable${randomToken().replaceAll('-', '')}${suffix}`.slice(0, 63)
}

async function deleteTableRowsInTransaction(
  tableClient: TableClient,
  rows: { partitionKey: string; rowKey: string }[],
): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const response = await tableClient.submitTransaction(
    rows.map((row) => ({
      action: 'delete',
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
    })),
  )

  expect(response.status).toBe(202)
  expect(response.subResponses).toHaveLength(rows.length)
  for (const rowResponse of response.subResponses) {
    expect([204, 202]).toContain(rowResponse.status)
  }
}
