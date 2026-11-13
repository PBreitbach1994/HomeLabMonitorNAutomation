// Minimal NetBox REST client: token auth (v1 "Token …" and v2 "Bearer nbt_…"), offset pagination,
// timeouts, and errors that never echo the token.

export interface NetBoxOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  pageSize?: number;
}

export interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}

export class NetBoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class NetBoxClient {
  readonly base: string;
  private auth: string;
  private timeoutMs: number;
  private pageSize: number;

  constructor(opts: NetBoxOptions) {
    if (!opts.url) throw new Error('netbox: "url" is required');
    if (!opts.token) throw new Error('netbox: "token" is required (set NETBOX_TOKEN)');
    this.base = opts.url.replace(/\/+$/, '').replace(/\/api$/, '');
    // NetBox 4.5+ v2 tokens look like nbt_<key>.<secret> and use the Bearer scheme.
    this.auth = opts.token.startsWith('nbt_') ? `Bearer ${opts.token}` : `Token ${opts.token}`;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.pageSize = opts.pageSize ?? 500;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base}/api/${path.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: this.auth,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      throw new NetBoxError(`can't reach NetBox at ${this.base}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        detail = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      } catch {
        /* no body */
      }
      const hint = res.status === 403 ? ' (check the token and its permissions)' : '';
      throw new NetBoxError(`${method} ${path} → ${res.status} ${res.statusText}${hint}${detail ? `: ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /** Fetches every page of a list endpoint. Uses offsets rather than `next`, which can carry the wrong host behind a proxy. */
  async list<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
      q.set('limit', String(this.pageSize));
      q.set('offset', String(offset));
      const page = await this.get<Page<T>>(`${path.replace(/\/?$/, '/')}?${q}`);
      out.push(...page.results);
      if (!page.next || page.results.length === 0 || out.length >= page.count) return out;
    }
  }
}
