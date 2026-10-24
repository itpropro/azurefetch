export type {
  TableEdmProperty,
  TableEntity,
  TableEntityProperty,
  TableEntityResult,
  TableEntityValue,
} from './internal/table-entity'
export { odata } from './internal/table-requests'
export type { TableCreateIfNotExistsResponse, TableDeleteResponse } from './internal/table-requests'
export { TableClient } from './table-client'
export type {
  TableEntityQueryOptions,
  TableEntityResponse,
  TableEntityWriteResponse,
  TableEtagOptions,
  TableTransactionAction,
  TableTransactionResponse,
  TableUpdateMode,
} from './table-client'
export { TableServiceClient } from './table-service-client'
