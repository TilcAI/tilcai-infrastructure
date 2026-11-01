# Testnet deployment recovery

The script requires Python 3 and a local Stellar CLI identity. It validates every argument,
checksummed G address and exact positive i128 amount before contract build/upload/deploy.
`--only accounts` does not require an operator. Network is always testnet.

Use a dedicated manifest path for each approved deployment:
`./deploy-testnet.sh --source operator --operator G... --manifest /secure/path/run.json`.
The manifest contains public identity/configuration, WASM hashes and per-step results; protect
its integrity. It is created exclusively and persisted before each chain operation. All WASMs
needed for the selected deployment must exist before the first upload.

An existing manifest always stops execution, including a completed run. There is no automatic
resume or overwrite. UNKNOWN means an operation may have landed even if the CLI returned an
error, an empty response or the process died. Never delete the journal and retry blindly.

After an interruption:

1. Preserve the journal and CLI logs. Compare network, source, configuration and artifact hashes.
2. Have the operator verify every completed ID and UNKNOWN operation against testnet using
   independent chain evidence and the source transaction history. Record transaction IDs,
   contract addresses, constructor arguments and code hashes. A CLI error is not rollback.
3. If evidence is insufficient, stop; no second deploy is permitted by this script.
4. Adopt the verified deployment through a separately reviewed operator procedure, or explicitly
   abandon it and approve a new deployment with a new journal. Do not reuse factory/verifier/vault
   IDs unless the full configuration is verified. Retain both journals and cross-reference them.

A script journal is not a transaction across chain operations. Build failures also leave the
journal in place for inspection. Do not share one run across different manifest paths. The
script does not coordinate separate operators using unrelated paths.

Automated tests use a fake CLI and temporary files. They never invoke a real Stellar network.
