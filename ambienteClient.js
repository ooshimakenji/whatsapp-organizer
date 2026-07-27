/**
 * Cliente mínimo do ambiente — login com uma conta de serviço e cache do JWT,
 * relogin automático em 401 (mesmo padrão do ambienteClient.js do ituran_avisos).
 */
const API_URL = (process.env.AMBIENTE_API_URL || '').replace(/\/$/, '');
const LOGIN = process.env.AMBIENTE_BOT_LOGIN || '';
const SENHA = process.env.AMBIENTE_BOT_SENHA || '';

let token = null;

export function ambienteHabilitado() {
  return Boolean(API_URL && LOGIN && SENHA);
}

async function login() {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, senha: SENHA }),
  });
  if (!res.ok) throw new Error(`login falhou: HTTP ${res.status}`);
  const data = await res.json();
  token = data.token;
}

async function chamarComRelogin(method, path, body) {
  if (!token) await login();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let res = await fetch(`${API_URL}${path}`, opts);
  if (res.status === 401) {
    await login();
    res = await fetch(`${API_URL}${path}`, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Ingest de foto — mesmo endpoint usado pelo listener ao vivo do ituran_avisos.
 * Idempotente no servidor (dedup por hash dentro da mesma saída): rodar 2x
 * sobre o mesmo arquivo não cria duplicata.
 */
export async function ingestFoto({ osSequencial, dataUrl, legenda }) {
  if (!ambienteHabilitado()) throw new Error('ambiente não configurado (AMBIENTE_API_URL/LOGIN/SENHA)');
  return chamarComRelogin('POST', '/fotos/ingest', { osSequencial, dataUrl, legenda });
}
