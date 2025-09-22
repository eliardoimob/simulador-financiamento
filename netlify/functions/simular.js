// netlify/functions/simular.js (V49.0 - Lógica de Cálculo Restaurada + Integrações)

// ====== CORS/Config ======
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://eliardosousa.com.br,https://www.eliardosousa.com.br").split(',').map(s => s.trim()).filter(Boolean);
const allowCors = (origin) => {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
};
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': isAllowed(origin) ? origin : ALLOWED_ORIGINS[0],
  'Vary': "Origin",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});
const isAllowed = (origin) => ALLOWED_ORIGINS.some(o => origin === o);

// ====== Utils ======
const BRL = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const pct = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')}%`;
const safe = (s) => (s ?? '').toString().trim();
function parseJSON(body) { try { return JSON.parse(body); } catch { return null; } }
function pickUTMs(utmObj) {
  if (!utmObj || typeof utmObj !== 'object') return null;
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const out = {}; let has = false;
  for (const k of keys) { if (utmObj[k]) { out[k] = utmObj[k]; has = true; } }
  return has ? out : null;
}
function timeoutSignal(ms = 4000) { const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), ms); return { signal: ctl.signal, cancel: () => clearTimeout(id) }; }

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

// =================================================================================
// ===== INÍCIO DA LÓGICA DE CÁLCULO RESTAURADA (O "CORAÇÃO" DA CALCULADORA) =====
// =================================================================================
const REGRAS = {
    MCMV: {
      F1: { id: 'Faixa 1', maxR: 2850, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: (r) => 4.25 },
      F2: { id: 'Faixa 2', maxR: 4700, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: (r) => {
          if (r <= 3200) return 5.00; if (r <= 4000) return 6.00; return 6.50;
      }},
      F3: { id: 'Faixa 3', maxR: 8600, tetoImovel: { novo: 350000, usado: 270000 }, ltv: { novo: 0.80, usado: 0.65 }, taxa: (r) => 7.66 },
      F4: { id: 'Classe Média', maxR: 12000, tetoImovel: { novo: 500000, usado: 500000 }, ltv: { novo: 0.80, usado: 0.60 }, taxa: (r) => 10.00 }
    },
    SBPE: { id: 'SBPE', maxR: Infinity, tetoImovel: 1500000, ltv: { sac: 0.70, price: 0.50 }, taxa: 10.99 },
    SFI_TR: { id: 'Taxa de Mercado', minValor: 1500000.01, ltv: 0.80, prazoMaxAnos: 35, taxa: 11.99 }
};

function resolverFaixa(renda, valorImovel, categoria) {
    if (valorImovel >= REGRAS.SFI_TR.minValor) { return { ...REGRAS.SFI_TR, programa: 'SFI' }; }
    const faixasMCMV = ['F1', 'F2', 'F3', 'F4'];
    for (const key of faixasMCMV) {
        const faixa = REGRAS.MCMV[key];
        const tetoImovel = typeof faixa.tetoImovel === 'object' ? faixa.tetoImovel[categoria] : faixa.tetoImovel;
        if (renda <= faixa.maxR && valorImovel <= tetoImovel) { return { ...faixa, programa: 'MCMV' }; }
    }
    return valorImovel <= REGRAS.SBPE.tetoImovel ? { ...REGRAS.SBPE, programa: 'SBPE' } : null;
}

function getSubsidioMCMV(renda, valorImovel, categoria, temFgts, temCo) {
    if (!temFgts || renda > 4400) return 0;
    let subsidio; const tetoMaximo = 55000;
    if (renda <= 2850) {
      const r1 = 1500, s1 = 14850; const r2 = 2850, s2 = 4845; const m = (s2 - s1) / (r2 - r1);
      subsidio = s1 + m * (renda - r1);
    } else {
      const p = [{r:2850, s:4845}, {r:3000, s:2135}, {r:4700, s:0}];
      if (renda >= p[2].r) subsidio = 0; else {
        const seg = renda <= p[1].r ? [p[0], p[1]] : [p[1], p[2]]; const m = (seg[1].s - seg[0].s) / (seg[1].r - seg[0].r);
        subsidio = seg[0].s + m * (renda - seg[0].r);
      }
    }
    let subsidioFinal = Math.min(subsidio, tetoMaximo);
    if (categoria === 'usado') { subsidioFinal *= 0.5; }
    return Math.max(0, Math.floor(subsidioFinal));
}

const pricePMT = (PV, i, n) => PV * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);

function solveMax(V, R, prazoAnos, taxaAnual, ltv, sistema, idade) {
    const n = prazoAnos * 12, i = (taxaAnual / 100) / 12, limite = R * 0.30;
    const TAXA_ADMIN = 25, DFI = 0.000138, MIP0 = 0.000038, mip = MIP0 * (1 + (idade - 20) * 0.05);
    const fixo = TAXA_ADMIN + V * DFI;
    let lo = 0, hi = V * ltv, ok = 0, p1 = 0, pf = 0;
    for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2, varEnc = mid * mip, enc = fixo + varEnc;
        const base = sistema === 'SAC' ? (mid / n) + (mid * i) : pricePMT(mid, i, n);
        if (base + enc <= limite) { ok = mid; p1 = base + enc; pf = sistema === 'SAC' ? (mid / n) + (mid / n * i) + enc : p1; lo = mid; } else hi = mid;
    }
    return { fv: ok, p1, pf };
}

function computeSimulation(payload) {
    const { valorImovel: V, rendaMensal: R, categoria: cat, idadeAnos: idade, flags } = payload;
    const { fgts: temFgts, subsidioRecebido: recebeuSub, co: temCo } = flags;

    if (!V || !R || !cat) throw new Error("Dados insuficientes para o cálculo");

    const faixa = (recebeuSub && V <= 1500000) ? { ...REGRAS.SBPE, programa: 'SBPE' } : resolverFaixa(R, V, cat);
    if (!faixa) { return { erroRegra: "Valor do imóvel acima do teto para as linhas de crédito disponíveis." }; }

    const prazoAnos = faixa.prazoMaxAnos || Math.max(1, Math.min(35, 80 - idade));
    const taxa = typeof faixa.taxa === 'function' ? faixa.taxa(R) : faixa.taxa;

    const subsidio = (faixa.programa === 'MCMV' && (faixa.id === 'Faixa 1' || faixa.id === 'Faixa 2'))
        ? getSubsidioMCMV(R, V, cat, temFgts, temCo)
        : 0;

    let ltvSac, ltvPrice;
    if (faixa.programa === 'MCMV') { ltvSac = ltvPrice = typeof faixa.ltv === 'object' ? faixa.ltv[cat] : faixa.ltv; }
    else if (faixa.programa === 'SBPE') { ltvSac = faixa.ltv.sac; ltvPrice = faixa.ltv.price; }
    else { ltvSac = ltvPrice = faixa.ltv; }

    const sac = solveMax(V, R, prazoAnos, taxa, ltvSac, 'SAC', idade);
    const price = solveMax(V, R, prazoAnos, taxa, ltvPrice, 'PRICE', idade);

    const entradaSac = Math.max(0, V - sac.fv - subsidio);
    const entradaPrice = Math.max(0, V - price.fv - subsidio);
    const custosDoc = V * 0.045;

    return {
        linha: `${faixa.programa || 'SFI'} — ${faixa.id}`,
        prazoMeses: prazoAnos * 12,
        taxaAnual: taxa,
        subsidio,
        sac: { ltv: ltvSac, entrada: entradaSac, financiamento: sac.fv, p1: sac.p1, pf: sac.pf },
        price: { ltv: ltvPrice, entrada: entradaPrice, financiamento: price.fv, p1: price.p1 },
        custosDoc
    };
}
// =================================================================================
// ===== FIM DA LÓGICA DE CÁLCULO RESTAURADA =======================================
// =================================================================================

// ====== Trello ======
const TRELLO_KEY = process.env.TRELLO_KEY || '';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '';
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID || '';
const TRELLO_LABEL_IDS = (process.env.TRELLO_LABEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TRELLO_MEMBER_IDS = (process.env.TRELLO_MEMBER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function trelloFetch(path, params = {}, method = 'POST', signal) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) throw new Error('TRELLO_KEY/TOKEN ausentes');
  const url = new URL(`https://api.trello.com/1/${path}`);
  url.searchParams.set('key', TRELLO_KEY);
  url.searchParams.set('token', TRELLO_TOKEN);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) { if (v != null) body.append(k, v); }
  const resp = await fetch(url.toString(), { method, body, signal });
  if (!resp.ok) throw new Error(await resp.text());
  return await resp.json();
}

// ====== Handler Netlify Function ======
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Referer?.slice(0,-1) || '';
  if (event.httpMethod === 'OPTIONS') { return { statusCode: 204, headers: corsHeaders(origin) }; }
  
  // A verificação de CORS foi movida para o início para simplicidade
  const headers = corsHeaders(origin);

  try {
    const body = parseJSON(event.body || '{}');
    if (!body) { return { statusCode: 400, headers, body: 'JSON inválido' }; }
    
    const { captchaToken, contato = {}, origem = '', utm = null, ...simulationPayload } = body;
    const ip = event.headers['x-nf-client-connection-ip'] || '';
    
    const isCaptchaValid = await verifyTurnstile(captchaToken, ip);
    if (!isCaptchaValid) { return { statusCode: 403, headers, body: 'Captcha inválido' }; }
    
    const result = computeSimulation(simulationPayload);
    if(result.erroRegra){ return { statusCode: 400, headers, body: JSON.stringify({ error: result.erroRegra }) }; }

    // Envio para o Trello em background
    (async () => {
        try {
            if (!TRELLO_LIST_ID) return;
            const titulo = `Simulação • ${safe(contato.nome)} • ${BRL(simulationPayload.valorImovel)}`;
            const utms = pickUTMs(utm);
            const dadosCliente = [ `**Nome:** ${safe(contato.nome)}`, `**E-mail:** ${safe(contato.email)}`, `**WhatsApp:** ${safe(contato.whatsapp)}`, `**Origem:** ${safe(origem)}`, utms ? `**UTM:** ${Object.entries(utms).map(([k,v])=>`${k}=${v}`).join(' | ')}` : null ].filter(Boolean).join('\n');
            const resumoTecnico = [ `**Programa:** ${safe(result.linha)}`, `**Taxa:** ${pct(result.taxaAnual)}`, `**Prazo:** ${result.prazoMeses} meses`, `**Subsídio:** ${BRL(result.subsidio)}`, '', `**SAC**`, `- Entrada: ${BRL(result.sac?.entrada)}`, `- 1ª Parcela: ${BRL(result.sac?.p1)}`, '', `**PRICE**`, `- Entrada: ${BRL(result.price?.entrada)}`, `- Parcela: ${BRL(result.price?.p1)}` ].join('\n');
            const desc = `## Dados do Cliente\n${dadosCliente}\n\n## Resumo da Simulação\n${resumoTecnico}`;
            const { signal, cancel } = timeoutSignal(4000);
            await trelloFetch('cards', { idList: TRELLO_LIST_ID, name: titulo, desc, pos: 'top', idLabels: TRELLO_LABEL_IDS.join(',') || undefined, idMembers: TRELLO_MEMBER_IDS.join(',') || undefined }, 'POST', signal);
            cancel();
        } catch (trelloErr) {
            console.warn('Trello falhou:', trelloErr?.message || trelloErr);
        }
    })();

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.warn('Handler error:', err?.message || err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erro interno no servidor.' }) };
  }
};
