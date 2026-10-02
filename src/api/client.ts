import type { Document } from "../core/types.js";

export interface ClientOptions {
  baseUrl: string;
  merchant: string;
  token?: string;
  /** Retries on 429/5xx/network errors. */
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Client for the configuration service: GET/PUT/DELETE channel documents. */
export class ConfigurationClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;

  constructor(private readonly options: ClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "") + "/api/v1/configuration";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 3;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "X-Merchant": this.options.merchant };
    if (json) h["Content-Type"] = "application/json";
    if (this.options.token) h.Authorization = `Bearer ${this.options.token}`;
    return h;
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await this.fetchImpl(url, { method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        netErr = e;
      }
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      if (!res) throw new ApiError(`${method} ${url}: ${String(netErr)}`, 0, "");
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401) {
          throw new ApiError(`${method} ${url}: 401 Unauthorized — check the merchant token (environments.<env>.token) and X-Merchant`, 401, text);
        }
        throw new ApiError(`${method} ${url}: ${res.status} ${res.statusText}${text ? `\n${text.slice(0, 500)}` : ""}`, res.status, text);
      }
      return res;
    }
  }

  private channelUrl(channel: string): string {
    return `${this.base}/merchants/${encodeURIComponent(this.options.merchant)}/channels/${encodeURIComponent(channel)}`;
  }

  async listChannels(): Promise<string[]> {
    const res = await this.request("GET", `${this.base}/merchants/${encodeURIComponent(this.options.merchant)}/channels`);
    return (await res.json()) as string[];
  }

  async getDocuments(channel: string): Promise<Document[]> {
    try {
      const res = await this.request("GET", `${this.channelUrl(channel)}/configurations`);
      return (await res.json()) as Document[];
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }

  /** Replaces the given documents; other documents in the channel are untouched. Creates the channel if needed. */
  async putDocuments(channel: string, documents: Document[]): Promise<Document[]> {
    const res = await this.request("PUT", `${this.channelUrl(channel)}/configurations`, documents);
    return (await res.json()) as Document[];
  }

  async deleteDocument(channel: string, id: string): Promise<void> {
    await this.request("DELETE", `${this.channelUrl(channel)}/configurations/${encodeURIComponent(id)}`);
  }
}
