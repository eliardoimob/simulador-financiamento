// netlify/functions/simular.js
exports.handler = async (event) => {
  // Domínio do SEU site/plataforma (onde roda o HTML do simulador)
  const allowedOrigin = "https://eliardosousa.com.br";

  const origin = event.headers.origin || "";
  const referer = event.headers.referer || "";
  const sameSite = origin === allowedOrigin || referer.startsWith(allowedOrigin);

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (!sameSite) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: "Origin not allowed" }) };
  }

  try {
    const { valorImovel, rendaMensal, categoria, idadeAnos, flags } = JSON.parse(event.body || "{}");

    // === Regras e lógica protegidas no backend ===
    const REGRAS = {
      MCMV: {
        F1: { id: 'Faixa 1', maxR: 2850, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: () => 4.25 },
        F2: { id: 'Faixa 2', maxR: 4700, tetoImovel: { novo: 264000, usado: 264000 }, ltv: 0.80, taxa: (r) => (r<=3200?5:r<=4000?6:6.5) },
        F3: { id: 'Faixa 3', maxR: 8600, tetoImovel: { novo: 350000, usado: 270000 }, ltv: { novo: 0.80, usado: 0.65 }, taxa: () => 7.66 },
        F4: { id: 'Classe Média', maxR: 12000, tetoImovel: { novo: 500000, usado: 500000 }, ltv: { novo: 0.80, usado: 0.60 }, taxa: () => 10.00 }
      },
      SBPE:  { id: 'SBPE', maxR: Infinity, tetoImovel: 1500000, ltv: { sac: 0.70, price: 0.50 }, taxa: 10.99 },
      SFI_TR:{ id: 'Taxa de Mercado', minValor: 1500000.01, ltv: 0.80, prazoMaxAnos: 35, taxa: 11.99 }
    };

    function resolverFaixa(renda, V, cat) {
      if (V >= REGRAS.SFI_TR.minValor) return { ...REGRAS.SFI_TR, programa: 'SFI' };
      for (const key of ['F1','F2','F3','F4']) {
        const f = REGRAS.MCMV[key];
        const teto = typeof f.tetoImovel === 'object' ? f.tetoImovel[cat] : f.tetoImovel;
        if (renda <= f.maxR && V <= teto) return { ...f, programa: 'MCMV' };
      }
      return V <= REGRAS.SBPE.tetoImovel ? { ...REGRAS.SBPE, programa: 'SBPE' } : null;
    }

    function getSubsidioMCMV(renda, V, cat, temFgts, temCo) {
      if (!temFgts || renda > 4400) return 0;
      let s, teto = 55000;
      if (renda <= 2850) {
        const r1=1500, s1=14850, r2=2850, s2=4845;
        const m=(s2-s1)/(r2-r1); s = s1 + m*(renda-r1);
      } else {
        const p=[{r:2850,s:4845},{r:3000,s:2135},{r:4700,s:0}];
        if (renda >= p[2].r) s=0; else {
          const [a,b] = renda <= p[1].r ? [p[0],p[1]] : [p[1],p[2]];
          const m=(b.s-a.s)/(b.r-a.r); s = a.s + m*(renda-a.r);
        }
      }
      let out = Math.min(s, teto);
      if (cat==='usado') out *= 0.5;
      return Math.max(0, Math.floor(out));
    }

    const pricePMT = (PV,i,n) => PV * (i * Math.pow(1+i,n)) / (Math.pow(1+i,n)-1);

    function solveMax(V, R, prazoAnos, taxaAnual, ltv, sistema, idade){
      const n = prazoAnos*12, i=(taxaAnual/100)/12, limite=R*0.30;
      const TAXA_ADMIN=25, DFI=0.000138, MIP0=0.000038, mip = MIP0 * (1 + (idade-20)*0.05);
      const fixo = TAXA_ADMIN + V*DFI;
      let lo=0, hi=V*ltv, ok=0, p1=0, pf=0;
      for(let k=0;k<50;k++){
        const mid=(lo+hi)/2, varEnc=mid*mip, enc=fixo+varEnc;
        const base = sistema==='SAC' ? (mid/n)+(mid*i) : pricePMT(mid,i,n);
        if (base+enc <= limite){ ok=mid; p1=base+enc; pf = sistema==='SAC' ? (mid/n)+(mid/n*i)+enc : p1; lo=mid; } else hi=mid;
      }
      return { fv: ok, p1, pf };
    }

    // Inputs
    const V = +valorImovel || 0, R = +rendaMensal || 0, cat = categoria||'novo', idade = +idadeAnos||30;
    const temFgts = !!(flags && flags.fgts), recebeuSub = !!(flags && flags.subsidioRecebido), temCo = !!(flags && flags.co);
    if (!V || !R || !cat) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error:"Dados insuficientes" }) };

    const faixa = (recebeuSub && V<=1500000) ? { ...REGRAS.SBPE, programa:'SBPE' } : resolverFaixa(R,V,cat);
    if (!faixa) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ erroRegra:"Acima do teto disponível" }) };

    const prazoAnos = faixa.prazoMaxAnos || Math.max(1, Math.min(35, 80 - idade));
    const taxa = typeof faixa.taxa==='function' ? faixa.taxa(R) : faixa.taxa;

    const subsidio = (faixa.programa==='MCMV' && (faixa.id==='Faixa 1'||faixa.id==='Faixa 2'))
      ? getSubsidioMCMV(R, V, cat, temFgts, temCo) : 0;

    let ltvSac, ltvPrice;
    if (faixa.programa==='MCMV'){ ltvSac=ltvPrice = typeof faixa.ltv==='object'?faixa.ltv[cat]:faixa.ltv; }
    else if (faixa.programa==='SBPE'){ ltvSac=faixa.ltv.sac; ltvPrice=faixa.ltv.price; }
    else { ltvSac=ltvPrice=faixa.ltv; }

    const sac   = solveMax(V,R,prazoAnos,taxa,ltvSac,'SAC',idade);
    const price = solveMax(V,R,prazoAnos,taxa,ltvPrice,'PRICE',idade);

    const entradaSac   = Math.max(0, V - sac.fv   - subsidio);
    const entradaPrice = Math.max(0, V - price.fv - subsidio);
    const custosDoc = V * 0.045;

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type":"application/json" },
      body: JSON.stringify({
        linha: `${faixa.programa || 'SFI'} — ${faixa.id}`,
        prazoMeses: prazoAnos*12,
        taxaAnual: taxa,
        subsidio,
        sac:   { ltv: ltvSac,   entrada: entradaSac,   financiamento: sac.fv,   p1: sac.p1,   pf: sac.pf },
        price: { ltv: ltvPrice, entrada: entradaPrice, financiamento: price.fv, p1: price.p1 },
        custosDoc
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Erro interno", detail: String(e) }) };
  }
};
