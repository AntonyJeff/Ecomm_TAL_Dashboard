const SF_LOGIN_URL = process.env.SF_LOGIN_URL!;
const SF_CONSUMER_KEY = process.env.SF_CONSUMER_KEY!;
const SF_CONSUMER_SECRET = process.env.SF_CONSUMER_SECRET!;

interface TokenState {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number;
}

let token: TokenState | null = null;

async function authenticate(): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SF_CONSUMER_KEY,
    client_secret: SF_CONSUMER_SECRET,
  });

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce auth failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { access_token: string; instance_url: string };
  return {
    accessToken: json.access_token,
    instanceUrl: json.instance_url,
    // Client Credentials tokens don't return expires_in reliably; refresh every 25 min.
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
}

async function getToken(): Promise<TokenState> {
  if (!token || Date.now() >= token.expiresAt) {
    token = await authenticate();
  }
  return token;
}

export async function getInstanceUrl(): Promise<string> {
  const t = await getToken();
  return t.instanceUrl;
}

async function rawQuery(soql: string): Promise<any> {
  const t = await getToken();
  const url = `${t.instanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${t.accessToken}` },
  });

  if (res.status === 401) {
    // token expired/revoked - force refresh once and retry
    token = null;
    const retryToken = await getToken();
    const retryRes = await fetch(url, {
      headers: { Authorization: `Bearer ${retryToken.accessToken}` },
    });
    if (!retryRes.ok) {
      throw new Error(`Salesforce query failed (${retryRes.status}): ${await retryRes.text()}`);
    }
    return retryRes.json();
  }

  if (!res.ok) {
    throw new Error(`Salesforce query failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

export async function soqlQuery<T = any>(soql: string): Promise<T[]> {
  let result = await rawQuery(soql);
  const records: T[] = [...result.records];

  // Follow pagination for large result sets.
  while (!result.done && result.nextRecordsUrl) {
    const t = await getToken();
    const res = await fetch(`${t.instanceUrl}${result.nextRecordsUrl}`, {
      headers: { Authorization: `Bearer ${t.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Salesforce pagination failed (${res.status}): ${await res.text()}`);
    }
    result = await res.json();
    records.push(...result.records);
  }

  return records;
}

/** Splits an array into chunks so SOQL IN-list queries stay under length limits. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
