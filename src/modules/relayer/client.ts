/**
 * OpenZeppelin Relayer HTTP client (relayer 1.8.x, see tilcai-core
 * docs/payment-rail-environment.md). TilcAI and the Relayer run on the same host,
 * so RELAYER_URL is http://localhost:8080 in production; the API key never leaves
 * this process and is never logged.
 */
export interface RelayerApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface StellarTxResponse {
  id: string;
  hash?: string | null;
  status: string; // canceled | pending | sent | submitted | mined | confirmed | failed | expired
  status_reason?: string | null;
  created_at: string;
  sent_at?: string | null;
  confirmed_at?: string | null;
  source_account: string;
  fee: number;
  sequence_number: number;
  relayer_id: string;
  transaction_result_xdr?: string | null;
}

export type ScValJson =
  | { u32: number }
  | { i128: { hi: string; lo: string } }
  | { bytes: string }
  | { address: string }
  | { symbol: string }
  | { string: string };

export interface InvokeContractOp {
  type: "invoke_contract";
  contract_address: string;
  function_name: string;
  args: ScValJson[];
  auth?: { type: "none" } | { type: "source_account" } | { type: "xdr"; entries: string[] };
}

export class RelayerHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Relayer HTTP ${status}`);
  }
}

export class RelayerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 35_000,
  ) {}

  /** Unauthenticated liveness probe. */
  async health(): Promise<boolean> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    return Boolean(res?.ok);
  }

  async listRelayers(): Promise<Array<{ id: string; name: string; network: string; network_type: string; paused: boolean; address?: string }>> {
    return this.unwrap(await this.request("GET", "/api/v1/relayers"));
  }

  async getRelayer(id: string): Promise<Record<string, unknown>> {
    return this.unwrap(await this.request("GET", `/api/v1/relayers/${encodeURIComponent(id)}`));
  }

  async getBalance(id: string): Promise<{ balance: number | string; unit: string }> {
    return this.unwrap(await this.request("GET", `/api/v1/relayers/${encodeURIComponent(id)}/balance`));
  }

  async sendStellarTransaction(relayerId: string, body: { network: string; operations: InvokeContractOp[] } | { network: string; transaction_xdr: string; fee_bump?: boolean; max_fee?: number }): Promise<StellarTxResponse> {
    return this.unwrap(await this.request("POST", `/api/v1/relayers/${encodeURIComponent(relayerId)}/transactions`, body));
  }

  /** EVM relayer: the relayer account is the sender and pays the gas. */
  async sendEvmTransaction(relayerId: string, body: { to: string; data: string; value?: number; speed?: "fast" | "fastest" | "average" | "safeLow"; gas_limit?: number }): Promise<StellarTxResponse> {
    return this.unwrap(await this.request("POST", `/api/v1/relayers/${encodeURIComponent(relayerId)}/transactions`, { value: 0, speed: "fast", ...body }));
  }

  async getTransaction(relayerId: string, txId: string): Promise<StellarTxResponse> {
    return this.unwrap(await this.request("GET", `/api/v1/relayers/${encodeURIComponent(relayerId)}/transactions/${encodeURIComponent(txId)}`));
  }

  // ── x402 facilitator plugin (raw_response: true → body is the facilitator payload) ──

  async x402(pluginId: string, route: "/supported" | "/verify" | "/settle", body?: unknown): Promise<{ status: number; body: any }> {
    const res = await this.request(body === undefined ? "GET" : "POST", `/api/v1/plugins/${encodeURIComponent(pluginId)}/call${route}`, body);
    return { status: res.status, body: res.json };
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (res.status === 401) throw new RelayerHttpError(401, "unauthorized");
    return { status: res.status, json };
  }

  private unwrap<T>(r: { status: number; json: any }): T {
    const env = r.json as RelayerApiResponse<T>;
    if (r.status >= 400 || !env?.success || env.data === undefined) {
      throw new RelayerHttpError(r.status, String(env?.error ?? env?.message ?? JSON.stringify(r.json)).slice(0, 500));
    }
    return env.data;
  }
}
