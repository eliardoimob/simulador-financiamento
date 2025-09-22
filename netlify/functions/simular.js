// netlify/functions/simular.js

// ====== CORS/Config ======
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowCors = (origin) => {
  // ⚠️ ajuste: permitir quando Origin vier vazio (same-origin)
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
};

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});

// ====== Utils ======
const BRL = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const pct = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')}%`;
const safe = (s) => (s ?? '').toString().trim();

function parseJSON(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function pickUTMs(utmObj) {
  if (!utmObj || typeof utmObj !== 'object') return null;
  const keys = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
  const out = {}; let has = false;
  for (const k of keys) if (utmObj[k]) { out[k] = utmObj[k]; has = true; }
  return has ? out : null;
}

// Timeout helper (não travar resposta)
function timeoutSignal(ms = 4000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, cancel: () => clearTimeout(id) };
}

// ====== Turnstile ======
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) throw new Error('TURNSTILE_SECRET_KEY ausente');
  const form = new URLSearchParams();
  form.set('secret', TURNSTILE_SECRET_KEY);
  form.set('response', token || '');
  if (ip) form.set('remoteip', ip);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await resp.json().catch(() => ({}));
  return !!data.success;
}

// ====== CÁLCULO (placeholder — mantenho o seu formato) ======
function computeSimulation(payload) {
  const { valorImovel = 0, rendaMensal = 0, categoria = 'novo' } = payload;

  const taxaAnual  = 9.5;
  const prazoMeses = 360;
  const subsidio   = payload?.flags?.subsidioRecebido ? 20000 : 0;
  const ltv        = 0.8;

  const entradaBase   = valorImovel * (1 - ltv);
  const entrada       = Math.max(0, entradaBase - subsidio);
  const financiamento = Math.max(0, valorImovel - entrada - subsidio);

  // SAC
  const amortizacao = financiamento / prazoMeses;
  const jurosMes1   = (financiamento * (taxaAnual/100)) / 12;
  const p1_sac      = Math.round(amortizacao + jurosMes1);
  const jurosUlt    = ((amortizacao) * (taxaAnual/100)) / 12;
  const pf_sac      = Math.max(0, Math.round(amortizacao + jurosUlt));

  // PRICE
  const i = (taxaAnual/100)/12;
  const pmt = i > 0 ? Math.round((financiamento * i) / (1 - Math.pow(1 + i, -prazoMeses))) : Math.round(financiamento / prazoMeses);

  return {
    ok: true,
    linha: categoria === 'usado' ? 'Habitação • Imóvel Usado' : 'Habitação • Imóvel Novo',
    valorImovel,
    rendaMensal,
    categoria,
    idadeAnos: payload.idadeAnos ?? null,
    flags: payload.flags || {},
    taxaAnual,
    prazoMeses,
    subsidio,
    sac:  { ltv, entrada, financiamento, p1: p1_sac, pf: pf_sac },
    price:{ ltv, entrada, financiamento, p1: pmt },
  };
}

// ====== 🔒 Trello ======
const TRELLO_KEY        = process.env.TRELLO_KEY || '';
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN || '';
const TRELLO_LIST_ID    = process.env.TRELLO_LIST_ID || '';
const TRELLO_LABEL_IDS  = (process.env.TRELLO_LABEL_IDS  || '').split(',').map(s => s.trim()).filter(Boolean);
const TRELLO_MEMBER_IDS = (process.env.TRELLO_MEMBER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function trelloFetch(path, params = {}, method = 'POST', signal) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) throw new Error('TRELLO_KEY/TRELLO_TOKEN ausentes');
  const url = new URL(`https://api.trello.com/1/${path}`);
  url.searchParams.set('key', TRELLO_KEY);
  url.searchParams.set('token', TRELLO_TOKEN);

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
    const resp = await fetch(url.toString(), { method, signal });
    if (!resp.ok) throw new Error(await resp.text());
    return await resp.json();
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null) body.append(k, v);
    const resp = await fetch(url.toString(), { method, body, signal });
    if (!resp.ok) throw new Error(await resp.text());
    return await resp.json();
  }
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';

  // Healthcheck simples: GET ?healthz=1
  if (event.httpMethod === 'GET' && event.queryStringParameters?.healthz === '1') {
    try {
      if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
        return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({
          ok:false, reason:'Missing env', hasKey:!!TRELLO_KEY, hasToken:!!TRELLO_TOKEN, hasList:!!TRELLO_LIST_ID
        })};
      }
      const r = await trelloFetch(`lists/${TRELLO_LIST_ID}`, {}, 'GET');
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok:true, list:{ id:r.id, name:r.name } }) };
    } catch (e) {
      return { statusCode: 502, headers: corsHeaders(origin), body: JSON.stringify({ ok:false, reason:String(e) }) };
    }
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }
  if (!allowCors(origin)) {
    return { statusCode: 403, headers: corsHeaders(origin), body: 'Origin not allowed' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...corsHeaders(origin), Allow: 'POST' }, body: 'Method Not Allowed' };
  }

  const body = parseJSON(event.body || '{}');
  if (!body) return { statusCode: 400, headers: corsHeaders(origin), body: 'Invalid JSON' };

  const {
    valorImovel, rendaMensal, categoria, idadeAnos, flags,
    captchaToken,
    contato = {}, origem = '', utm = null,
  } = body;

  // Turnstile
  try {
    const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-real-ip'] || event.headers['client-ip'] || '';
    const ok = await verifyTurnstile(captchaToken, ip);
    if (!ok) return { statusCode: 403, headers: corsHeaders(origin), body: 'captcha inválido' };
  } catch (err) {
    console.warn('Turnstile error:', err?.message || err);
    return { statusCode: 500, headers: corsHeaders(origin), body: 'Erro ao validar captcha' };
  }

  // Cálculo
  const simulationPayload = { valorImovel, rendaMensal, categoria, idadeAnos, flags };
  const result = computeSimulation(simulationPayload);

  // 🔒 Trello — em background
  (async () => {
    try {
      if (!TRELLO_LIST_ID) throw new Error('TRELLO_LIST_ID ausente');

      const nomeCliente = safe(contato.nome) || 'Sem nome';
      const titulo = `Simulação • ${nomeCliente} • ${BRL(valorImovel)} • ${safe(categoria)}`;

      const utms = pickUTMs(utm);
      const dadosCliente = [
        `**Nome:** ${safe(contato.nome) || '-'}`,
        `**E-mail:** ${safe(contato.email) || '-'}`,
        `**WhatsApp:** ${safe(contato.whatsapp) || '-'}`,
        `**Origem:** ${safe(origem) || '-'}`,
        utms ? `**UTM:** ${Object.entries(utms).map(([k,v])=>`${k}=${v}`).join(' | ')}` : null,
      ].filter(Boolean).join('\n');

      const resumoTecnico = [
        `**Linha/Programa:** ${safe(result.linha || result.categoria)}`,
        `**Taxa anual:** ${pct(result.taxaAnual)}`,
        `**Prazo:** ${result.prazoMeses} meses`,
        `**Subsídio:** ${BRL(result.subsidio)}`,
        '',
        `**SAC**`,
        `- LTV: ${(result.sac?.ltv*100 || 0).toFixed(0)}%`,
        `- Entrada: ${BRL(result.sac?.entrada)}`,
        `- Financiamento: ${BRL(result.sac?.financiamento)}`,
        `- Parcela 1: ${BRL(result.sac?.p1)}`,
        `- Parcela final: ${BRL(result.sac?.pf)}`,
        '',
        `**PRICE**`,
        `- LTV: ${(result.price?.ltv*100 || 0).toFixed(0)}%`,
        `- Entrada: ${BRL(result.price?.entrada)}`,
        `- Financiamento: ${BRL(result.price?.financiamento)}`,
        `- Parcela: ${BRL(result.price?.p1)}`,
      ].join('\n');

      const desc = [`## Dados do cliente`, dadosCliente, '', `## Resumo técnico`, resumoTecnico].join('\n');

      const { signal, cancel } = timeoutSignal(4000);

      const card = await trelloFetch('cards', {
        idList: TRELLO_LIST_ID,
        name: titulo,
        desc,
        pos: 'top',
        idLabels: TRELLO_LABEL_IDS.join(',') || undefined,
        idMembers: TRELLO_MEMBER_IDS.join(',') || undefined,
      }, 'POST', signal);

      console.log({ cardId: card?.id, nome: nomeCliente, valorImovel });

      // anexa JSON (opcional)
      try {
        const jsonData = { contato, origem, utm: utms || null, input: simulationPayload, output: result, createdAt: new Date().toISOString() };
        const dataUrl = 'data:application/json;base64,' + Buffer.from(JSON.stringify(jsonData, null, 2)).toString('base64');
        await trelloFetch(`cards/${card.id}/attachments`, { url: dataUrl, name: `simulacao-${Date.now()}.json` }, 'POST', signal);
      } catch (annexErr) {
        console.warn('Trello anexar JSON falhou:', annexErr?.message || annexErr);
      }

      if (origem) {
        try {
          await trelloFetch(`cards/${card.id}/attachments`, { url: origem, name: 'Origem da simulação' }, 'POST', signal);
        } catch (annexUrlErr) {
          console.warn('Trello anexar origem falhou:', annexUrlErr?.message || annexUrlErr);
        }
      }

      cancel();
    } catch (err) {
      console.warn('Trello falhou:', err?.message || err);
    }
  })();

  return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(result) };
};
