// netlify/functions/simular.js

// ====== CORS/Config ======
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowCors = (origin) => {
  // tolerante: se o header vier vazio em same-origin, aceita
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

function parseJSON(body) { try { return JSON.parse(body); } catch { return null; } }

function pickUTMs(utmObj) {
  if (!utmObj || typeof utmObj !== 'object') return null;
  const keys = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
  const out = {}; let has = false;
  for (const k of keys) if (utmObj[k]) { out[k] = utmObj[k]; has = true; }
  return has ? out : null;
}

function timeoutSignal(ms = 4000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, cancel: () => clearTimeout(id) };
}

// ====== Turnstile ======
const TURNSTILE_SECRET_KEY =
  process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET || '';

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

// ====== Parâmetros do simulador (ajustáveis por ENV) ======
const TAXA_AA_NOVO  = Number(process.env.SIM_TAXA_AA_NOVO  || process.env.SIM_TAXA_AA || 9.5);
const TAXA_AA_USADO = Number(process.env.SIM_TAXA_AA_USADO || TAXA_AA_NOVO);
const PRAZO_MESES   = Math.max(60, Number(process.env.SIM_PRAZO_MESES || 360)); // mínimo 60
const LTV_NOVO      = Math.min(1, Math.max(0.1, Number(process.env.SIM_LTV_NOVO  || 0.80)));
const LTV_USADO     = Math.min(1, Math.max(0.1, Number(process.env.SIM_LTV_USADO || 0.80)));
const RENDA_PCT     = Math.min(1, Math.max(0.1, Number(process.env.SIM_RENDA_PCT || 0.30))); // 30%

// ====== Fórmulas ======
const toIm = (aa) => (Number(aa)/100)/12; // i mensal a partir da taxa a.a.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function pricePMT(PV, i, n) {
  if (i <= 0) return PV / n;
  return (PV * i) / (1 - Math.pow(1 + i, -n));
}

function sacFirstLast(PV, i, n) {
  const amort = PV / n;
  const p1 = amort + PV * i;             // 1ª = amortização + juros sobre saldo cheio
  const pf = amort + amort * i;          // última ≈ amortização + juros sobre última parcela
  return { p1, pf };
}

// ====== CÁLCULO PRINCIPAL ======
function computeSimulation(payload) {
  const { valorImovel = 0, rendaMensal = 0, categoria = 'novo', idadeAnos = null } = payload;

  // Taxa e LTV por categoria
  const taxaAnual = (categoria === 'usado') ? TAXA_AA_USADO : TAXA_AA_NOVO;
  const ltvAlvo   = (categoria === 'usado') ? LTV_USADO     : LTV_NOVO;

  // Prazo: regra comum "idade + prazo <= 80 anos"
  const prazoMaxIdade = (idadeAnos && idadeAnos > 0) ? Math.max(60, (80 - idadeAnos) * 12) : PRAZO_MESES;
  const prazoMeses = Math.min(PRAZO_MESES, prazoMaxIdade);

  // Entrada mínima por LTV alvo
  const subsidio = 0; // NÃO conceder subsídio automático; só mostrar se existir em outra fonte
  const entradaMin = Math.max(0, valorImovel * (1 - ltvAlvo) - subsidio);
  let financiamento = Math.max(0, valorImovel - entradaMin - subsidio);

  // Ajuste por renda: se PRICE > RENDA_PCT * renda, reduz financiamento (aumenta entrada)
  const i = toIm(taxaAnual);
  const parcelaPrice = pricePMT(financiamento, i, prazoMeses);
  const limiteParcela = rendaMensal > 0 ? rendaMensal * RENDA_PCT : Infinity;

  if (parcelaPrice > limiteParcela && isFinite(limiteParcela)) {
    // PV permitido pela renda
    const pvPermitido = limiteParcela * (i > 0 ? (1 - Math.pow(1 + i, -prazoMeses)) / i : prazoMeses);
    financiamento = Math.max(0, Math.min(financiamento, pvPermitido));
  }

  const entrada = Math.max(0, valorImovel - financiamento - subsidio);
  const ltvReal = valorImovel > 0 ? financiamento / valorImovel : 0;

  // PRICE e SAC (com base no financiamento ajustado)
  const priceParcela = pricePMT(financiamento, i, prazoMeses);
  const { p1: sacP1, pf: sacPf } = sacFirstLast(financiamento, i, prazoMeses);

  return {
    ok: true,
    linha: categoria === 'usado' ? 'Habitação • Imóvel Usado' : 'Habitação • Imóvel Novo',
    categoria,
    valorImovel: round2(valorImovel),
    rendaMensal: round2(rendaMensal),
    taxaAnual: round2(taxaAnual),
    prazoMeses,
    subsidio: round2(subsidio),

    sac: {
      ltv: round2(ltvReal),
      entrada: round2(entrada),
      financiamento: round2(financiamento),
      p1: round2(sacP1),
      pf: round2(sacPf),
    },

    price: {
      ltv: round2(ltvReal),
      entrada: round2(entrada),
      financiamento: round2(financiamento),
      p1: round2(priceParcela),
    },
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

// ====== Handler ======
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';

  // Healthcheck GET ?healthz=1 (opcional)
  if (event.httpMethod === 'GET' && event.queryStringParameters?.healthz === '1') {
    try {
      if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
        return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({
          ok:false, reason:'Missing env', hasKey:!!TRELLO_KEY, hasToken:!!TRELLO_TOKEN, hasList:!!TRELLO_LIST_ID
        })};
      }
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ ok:true }) };
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
  const result = computeSimulation({ valorImovel, rendaMensal, categoria, idadeAnos, flags });

  // 🔒 Trello em background (igual ao seu)
  (async () => {
    try {
      if (!TRELLO_LIST_ID) throw new Error('TRELLO_LIST_ID ausente');

      const utms = pickUTMs(utm);
      const nomeCliente = safe(contato.nome) || 'Sem nome';
      const titulo = `Simulação • ${nomeCliente} • ${BRL(valorImovel)} • ${safe(categoria)}`;

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

      try {
        const jsonData = { contato, origem, utm: utms || null, input: { valorImovel, rendaMensal, categoria, idadeAnos, flags }, output: result, createdAt: new Date().toISOString() };
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
