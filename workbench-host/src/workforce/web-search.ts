interface CredentialStatus {
  describe(ref: string): Promise<unknown>
}
export interface SearchLaunchEnvironment {
  get(name: string): { readonly value: string } | undefined
}

/** dsh-base uses this reference; describe covers the credential file and launch environment without resolving a secret. */
export async function webSearchStatus(credentials: CredentialStatus | undefined, environment?: SearchLaunchEnvironment): Promise<{ configured: boolean }> {
  if (credentials) {
    const status = await credentials.describe('DEEPSEEK_API_KEY')
    return { configured: (status as { configured?: boolean } | undefined)?.configured === true }
  }
  // Match the native provider's launchEnvironmentOf fallback; only expose presence.
  return { configured: environment ? (environment.get('DEEPSEEK_API_KEY')?.value.length ?? 0) > 0 : (process.env.DEEPSEEK_API_KEY?.length ?? 0) > 0 }
}
