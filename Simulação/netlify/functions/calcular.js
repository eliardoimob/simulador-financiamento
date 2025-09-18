// ARQUIVO DA LÓGICA SECRETA (V48.1 - COM CORREÇÃO DE CORS)
// Este código roda no servidor da Netlify, protegido de cópias.

// Helpers
const toNum = v => v ? parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0 : 0;

// REGRAS CENTRALIZADAS
const REGRAS = { /* ... A estrutura de regras permanece idêntica ... */ };

// FUNÇÕES DE CÁLCULO
function resolverFaixa(/*...*/) { /* ... A função permanece idêntica ... */ }
function getSubsidioMCMV(/*...*/) { /* ... A função permanece idêntica ... */ }
function pricePMT(/*...*/) { /* ... A função permanece idêntica ... */ }
function resolverFinanciamentoMax(/*...*/) { /* ... A função permanece idêntica ... */ }
// OBS: O corpo das funções foi omitido aqui para brevidade, mas está completo no código abaixo.

// O "CABEÇALHO" QUE A NETLIFY PRECISA
exports.handler = async (event, context) => {
    // --- INÍCIO DA CORREÇÃO DE CORS ---
    // Define quais domínios podem acessar esta API.
    const allowedOrigins = ['https://eliardosousa.com.br', 'https://www.eliardosousa.com.br'];
    const origin = event.headers.origin;
    
    // Configura os cabeçalhos de resposta.
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (allowedOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }

    // O navegador envia uma requisição "OPTIONS" antes do "POST" para verificar as permissões.
    // Se for, apenas retornamos as permissões e encerramos.
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204, // No Content
            headers,
            body: ''
        };
    }
    // --- FIM DA CORREÇÃO DE CORS ---

    try {
        const payload = JSON.parse(event.body);
        
        // ... TODA A LÓGICA DE CÁLCULO QUE JÁ EXISTIA ...
        // (O corpo da lógica foi omitido aqui para brevidade, mas está completo no código abaixo.)

        return {
            statusCode: 200,
            headers, // Adiciona os cabeçalhos de permissão à resposta de sucesso
            body: JSON.stringify({ /* ... dados do resultado ... */ })
        };

    } catch (error) {
        return { 
            statusCode: 500,
            headers, // Adiciona os cabeçalhos de permissão também à resposta de erro
            body: JSON.stringify({ error: error.message || 'Ocorreu um erro ao processar a simulação.' }) 
        };
    }
};


// ========= CÓDIGO COMPLETO PARA COPIAR E COLAR ABAIXO =========

/*
  COPIE TUDO A PARTIR DAQUI ATÉ O FINAL E SUBSTITUA O CONTEÚDO
  DO SEU ARQUIVO 'netlify/functions/calcular.js' NO GITHUB.
*/

// ARQUIVO DA LÓGICA SECRETA (V48.1 - COM CORREÇÃO DE CORS)
const toNum = v => v ? parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0 : 0;

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

function pricePMT(PV, i, n) { return PV * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1); }

function resolverFinanciamentoMax(valorImovel, rendaMensal, prazoAnos, taxaAnual, ltv, sistema, idade) {
    const n = prazoAnos * 12; const i = (taxaAnual / 100) / 12; const limitePrestacao = rendaMensal * 0.30;
    const TAXA_ADMIN = 25.00; const DFI_ALIQUOTA = 0.000138; const MIP_ALIQUOTA_BASE = 0.000038;
    const mipAliquota = MIP_ALIQUOTA_BASE * (1 + (idade - 20) * 0.05);
    const encargosFixos = TAXA_ADMIN + (valorImovel * DFI_ALIQUOTA);
    let lo = 0, hi = valorImovel * ltv, finMax = 0, p1 = 0, pf = 0;
    for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2; const encargosVariaveis = mid * mipAliquota; const encargosTotais = encargosFixos + encargosVariaveis;
        let parcelaCore;
        if (sistema === 'SAC') { parcelaCore = (mid / n) + (mid * i); } else { parcelaCore = pricePMT(mid, i, n); }
        if (parcelaCore + encargosTotais <= limitePrestacao) {
            finMax = mid; p1 = parcelaCore + encargosTotais;
            if (sistema === 'SAC') { const ultimaAmort = mid / n; pf = ultimaAmort + (ultimaAmort * i) + encargosTotais; } else { pf = p1; }
            lo = mid;
        } else { hi = mid; }
    }
    return { fv: finMax, p1, pf };
}

exports.handler = async (event, context) => {
    const allowedOrigins = ['https://eliardosousa.com.br', 'https://www.eliardosousa.com.br', 'http://localhost:3000'];
    const origin = event.headers.origin;
    const headers = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (allowedOrigins.includes(origin)) { headers['Access-Control-Allow-Origin'] = origin; }

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    try {
        const payload = JSON.parse(event.body);
        const { valorImovel: V, renda: R, categoria: C, dataNascimento, temFgts, recebeuSubsidio, temCo } = payload;

        const dt = dataNascimento.split('/');
        const dn = new Date(`${dt[2]}-${dt[1]}-${dt[0]}`);
        const hoje = new Date();
        let idade = hoje.getFullYear() - dn.getFullYear();
        const m = hoje.getMonth() - dn.getMonth();
        if (m < 0 || (m === 0 && hoje.getDate() < dn.getDate())) idade--;
        
        const faixa = recebeuSubsidio && V <= REGRAS.SBPE.tetoImovel ? REGRAS.SBPE : resolverFaixa(R, V, C);
        if (!faixa) { throw new Error('Com base nos dados informados, o valor do imóvel excede o teto para as linhas de crédito disponíveis.'); }

        const prazoMaxAnos = faixa.prazoMaxAnos || Math.max(1, Math.min(35, Math.floor((80 * 12 + 6 - (idade * 12 + m)) / 12)));
        const linha = `${faixa.programa || 'SFI'} — ${faixa.id}`;
        const taxaJuros = typeof faixa.taxa === 'function' ? faixa.taxa(R) : faixa.taxa;
        const subsidio = (faixa.programa === 'MCMV' && (faixa.id === 'Faixa 1' || faixa.id === 'Faixa 2')) ? getSubsidioMCMV(R, V, C, temFgts, temCo) : 0;
        
        let ltvSac, ltvPrice;
        if (faixa.programa === 'MCMV') { ltvSac = ltvPrice = typeof faixa.ltv === 'object' ? faixa.ltv[C] : faixa.ltv;
        } else if (faixa.programa === 'SBPE') { ltvSac = faixa.ltv.sac; ltvPrice = faixa.ltv.price;
        } else { ltvSac = ltvPrice = faixa.ltv; }

        const resSac = resolverFinanciamentoMax(V, R, prazoMaxAnos, taxaJuros, ltvSac, 'SAC', idade);
        const resPrice = resolverFinanciamentoMax(V, R, prazoMaxAnos, taxaJuros, ltvPrice, 'PRICE', idade);

        if (resSac.fv < V * 0.1) { throw new Error('Renda insuficiente para as condições informadas. O valor de entrada seria muito alto.'); }
        
        const entradaSac = Math.max(0, V - resSac.fv - subsidio);
        const entradaPrice = Math.max(0, V - resPrice.fv - subsidio);
        const custosDoc = V * 0.045;

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ V, R, C, linha, prazoMaxAnos, taxaJuros, subsidio, ltvSac, ltvPrice, resSac, resPrice, entradaSac, entradaPrice, custosDoc })
        };

    } catch (error) {
        return { 
            statusCode: 400, // Usar 400 para erros de validação/negócio
            headers,
            body: JSON.stringify({ error: error.message || 'Ocorreu um erro ao processar a simulação.' }) 
        };
    }
};
