/** Same-origin API prefix shared by the core bot clients. */
export const API_PREFIX = '/wb/api'

export interface ApiErrorBody {
  readonly code: string
  readonly message: string
}

/** Host errors retain their code, HTTP status and original message. */
export class WorkbenchApiError extends Error {
  readonly code: string
  constructor(error: ApiErrorBody, readonly status?: number) {
    super(error.message)
    this.name = 'WorkbenchApiError'
    this.code = error.code
  }
}

/** Injectable browser fetch signature. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
