const BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:5000';

function getToken(): string | null {
  return localStorage.getItem('titan-token');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawData = await res.json().catch(() => ({}));

  // 1. 物理层校验 (HTTP Status)
  if (!res.ok) {
    throw new Error(rawData?.msg || rawData?.message || `HTTP ${res.status}`);
  }

  // 2. 逻辑层校验 (Business Code)
  // 假设 200, 0, 20000 均代表成功
  const successCodes = [200, 1, '200', '1', '0000', '20000'];
  if (rawData.code !== undefined && !successCodes.includes(rawData.code)) {
    throw new Error(rawData.msg || rawData.message || '业务逻辑错误');
  }

  // 3. 自动解包 (如果有 data 字段则返回 data，否则返回原始数据)
  return (rawData.data !== undefined ? rawData.data : rawData) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};
