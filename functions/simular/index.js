// functions/simular/index.js — Cloudflare Pages

// --- REGRAS & CÁLCULOS ---
const REGRAS = {
  MCMV: {
    F1: { id: 'Faixa 1', maxR: 2850, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: (r) => 4.25 },
    F2: { id: 'Faixa 2', maxR: 4700, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: (r) => { if (r <= 3200) return 5.00; if (r <= 4000) return 6.00; return 6.50; } },
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
    const r1 = 1500, s1 = 14850; const r2 = 2850, s2 = 4845;
    const m = (s2 - s1) / (r2 - r1); subsidio = s1 + m * (renda - r1);
  } else {
    const p = [{ r: 2850, s: 4845 }, { r: 3000, s: 2135 }, { r: 4700, s: 0 }];
    if (renda >= p[2].r) subsidio = 0;
    else { const seg = renda <= p[1].r ? [p[0], p[1]] : [p[1], p[2]]; const m = (seg[1].s - seg[0].s) / (seg[1].r - seg[0].r); subsidio = seg[0].s + m * (renda - seg[0].r); }
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
    if (base + enc <= limite) { ok = mid; p1 = base + enc; pf = sistema === 'SAC' ? (mid / n) + (mid / n * i) + enc : p1; lo = mid; }
    else hi = mid;
  }
  return { fv: ok, p1, pf };
}

function computeSimulation(payload) {
  const { valorImovel: V, rendaMensal: R, categoria: cat, idadeAnos: idade, flags } = payload;
  const { fgts: temFgts, subsidioRecebido: recebeuSub, co: temCo } = flags;
  if (!V || !R || !cat) throw new Error("Dados insuficientes");

  const faixa = (recebeuSub && V <= 1500000) ? { ...REGRAS.SBPE, programa: 'SBPE' } : resolverFaixa(R, V, cat);
  if (!faixa) { return { erroRegra: "Valor acima do teto" }; }

  const prazoAnos = faixa.prazoMaxAnos || Math.max(1, Math.min(35, 80 - idade));
  const taxa = typeof faixa.taxa === 'function' ? faixa.taxa(R) : faixa.taxa;

  const subsidio = (faixa.programa === 'MCMV' && (faixa.id === 'Faixa 1' || faixa.id === 'Faixa 2'))
    ? getSubsidioMCMV(R, V, cat, temFgts, temCo) : 0;

  let ltvSac, ltvPrice;
  if (faixa.programa === 'MCMV') {
    ltvSac = ltvPrice = typeof faixa.ltv === 'object' ? faixa.ltv[cat] : faixa.ltv;
  } else if (faixa.programa === 'SBPE') {
    ltvSac = faixa.ltv.sac; ltvPrice = faixa.ltv.price;
  } else {
    ltvSac = ltvPrice = faixa.ltv;
  }

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

// --- INTEGRAÇÕES (Trello, Turnstile, CORS) ---
const BRL = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0);
const pct = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')}%`;
const safe = (s) => (s ?? '').toString().trim();

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) throw new Error('TURNSTILE_SECRET_KEY ausente');
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token || '');
  if (ip) form.set('remoteip', ip);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await resp.json().catch(() => ({}));
  return !!data.success;
}

async function sendToTrello(result, contato, origem, utm, env) {
  try {
    if (!env.TRELLO_LIST_ID || !env.TRELLO_KEY || !env.TRELLO_TOKEN) return;
    const valorImovel = result.sac?.financiamento > 0 ? result.sac.financiamento + result.sac.entrada : result.price.financiamento + result.price.entrada;
    const titulo = `Simulação • ${safe(contato.nome)} • ${BRL(valorImovel)}`;
    const dadosCliente = [
      `**Nome:** ${safe(contato.nome)}`,
      `**E-mail:** ${safe(contato.email)}`,
      `**WhatsApp:** ${safe(contato.whatsapp)}`,
      `**Origem:** ${safe(origem)}`
    ].join('\n');
    const resumoTecnico = [
      `**Programa:** ${safe(result.linha)}`,
      `**Taxa:** ${pct(result.taxaAnual)}`,
      `**Prazo:** ${result.prazoMeses} meses`,
      `**Subsídio:** ${BRL(result.subsidio)}`,
      '',
      `**SAC**`,
      `- Entrada: ${BRL(result.sac?.entrada)}`,
      `- 1ª Parcela: ${BRL(result.sac?.p1)}`,
      '',
      `**PRICE**`,
      `- Entrada: ${BRL(result.price?.entrada)}`,
      `- Parcela: ${BRL(result.price?.p1)}`
    ].join('\n');

    const url = new URL(`https://api.trello.com/1/cards`);
    url.searchParams.set('key', env.TRELLO_KEY);
    url.searchParams.set('token', env.TRELLO_TOKEN);
    url.searchParams.set('idList', env.TRELLO_LIST_ID);
    url.searchParams.set('name', titulo);
    url.searchParams.set('desc', `## Dados do Cliente\n${dadosCliente}\n\n## Resumo da Simulação\n${resumoTecnico}`);
    url.searchParams.set('pos', 'top');
    if (env.TRELLO_LABEL_IDS) url.searchParams.set('idLabels', env.TRELLO_LABEL_IDS);
    await fetch(url.toString(), { method: 'POST' });
  } catch (err) {
    console.warn('Trello falhou:', err?.message || err);
  }
}

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
});

// --- HANDLERS ---
export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || "";

  // Inclua todos os domínios que vão chamar a API
  const allowedOrigins = [
    "https://eliardosousa.com.br",
    "https://www.eliardosousa.com.br",
    "https://f2c63d72.simulador-financiamento.pages.dev"
  ];

  if (!allowedOrigins.includes(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: corsHeaders(origin) });
  }

  try {
    const body = await request.json();
    const { captchaToken, contato = {}, origem = '', utm = null, ...simulationPayload } = body;

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const isCaptchaValid = await verifyTurnstile(captchaToken, ip, env);
    if (!isCaptchaValid) {
      return new Response(JSON.stringify({ error: 'Captcha inválido' }), { status: 403, headers: corsHeaders(origin) });
    }

    const result = computeSimulation(simulationPayload);
    if (result.erroRegra) {
      return new Response(JSON.stringify({ error: result.erroRegra }), { status: 400, headers: corsHeaders(origin) });
    }

    context.waitUntil(sendToTrello(result, contato, origem, utm, env));
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders(origin) });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor.' }), { status: 500, headers: corsHeaders(origin) });
  }
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get("Origin") || "";
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Allow': 'POST, OPTIONS'
    }
  });
}
