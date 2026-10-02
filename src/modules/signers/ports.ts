// Phase 3 · owner: Jose. Signing boundary separate from the model and business data (report §12.7, §20.4).
export interface SignerProvider {
  /** Signs only after re-verifying the exact invocation against the approved action hash. */
  authorizeSorobanInvocation(input: { actionHash: string; authEntryXdr: string; validUntilLedger: number }): Promise<{ signedAuthEntryXdr: string }>;
  publicKey(): Promise<string>;
}
