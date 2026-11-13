
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

const PORTA = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODELO = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const supabaseAdmin = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// PÁGINA PRINCIPAL
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// PÁGINA DE VENDAS
app.get("/vendas.html", (req, res) => {
  res.sendFile(path.join(__dirname, "vendas.html"));
});


// CONFIGURAÇÃO PÚBLICA DO SUPABASE (a chave publishable pode ser exposta no navegador)
app.get("/api/config", (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ erro: "Autenticação ainda não configurada." });
  }
  res.set("Cache-Control", "no-store");
  return res.json({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY });
});

// Valida a sessão e o plano antes de permitir uma análise.
async function validarAcesso(req) {
  const autorizacao = req.headers.authorization || "";
  const token = autorizacao.startsWith("Bearer ") ? autorizacao.slice(7) : "";
  if (!token) return { erro: "Faça login para utilizar a plataforma.", status: 401 };

  const { data: usuarioData, error: erroAuth } = await supabase.auth.getUser(token);
  if (erroAuth || !usuarioData?.user) {
    return { erro: "Sua sessão expirou. Entre novamente.", status: 401 };
  }
  if (!supabaseAdmin) {
    return { erro: "A autenticação administrativa não está configurada.", status: 503 };
  }

  const { data: assinatura, error: erroAssinatura } = await supabaseAdmin
    .from("subscriptions")
    .select("plan,status,analyses_limit,period_start,period_end")
    .eq("user_id", usuarioData.user.id)
    .maybeSingle();

  if (erroAssinatura) throw erroAssinatura;
  if (!assinatura || assinatura.status !== "active") {
    return { erro: "Não encontramos uma assinatura ativa. Escolha um plano para continuar.", status: 403 };
  }

  const agora = new Date();
  const inicio = assinatura.period_start
    ? new Date(assinatura.period_start)
    : new Date(agora.getFullYear(), agora.getMonth(), 1);
  const fim = assinatura.period_end ? new Date(assinatura.period_end) : null;
  if (fim && fim <= agora) {
    return { erro: "Sua assinatura está vencida. Renove o plano para continuar.", status: 403 };
  }

  const { count, error: erroContagem } = await supabaseAdmin
    .from("analysis_usage")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", usuarioData.user.id)
    .gte("created_at", inicio.toISOString());

  if (erroContagem) throw erroContagem;
  const limite = Number(assinatura.analyses_limit || 0);
  if (limite < 1 || (count || 0) >= limite) {
    return { erro: "Você atingiu o limite de análises do seu plano neste período.", status: 403 };
  }

  return { user: usuarioData.user };
}

// STATUS DO SERVIDOR
app.get("/api/status", (req, res) => {
  res.json({
    funcionando: true,
    provedor: "Groq",
    modelo: MODELO,
    chaveConfigurada: Boolean(GROQ_API_KEY),
    supabaseConfigurado: Boolean(supabase)
  });
});

// TESTE E DIAGNÓSTICO DO SUPABASE
app.get("/api/supabase-status", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      conectado: false,
      erro: "Supabase não foi configurado no servidor."
    });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);

    if (error) {
      const diagnostico = {
        tipo: "RESPOSTA_SUPABASE",
        codigo: error.code || null,
        mensagem: error.message || null,
        detalhes: error.details || null,
        dica: error.hint || null
      };

      console.error(
        "Erro retornado pelo Supabase:",
        JSON.stringify(diagnostico)
      );

      return res.status(502).json({
        conectado: false,
        diagnostico
      });
    }

    return res.json({
      conectado: true,
      mensagem: "Supabase conectado com sucesso."
    });

  } catch (erro) {
    const diagnostico = {
      nome: erro?.name || null,
      mensagem: erro?.message || null,
      causaNome: erro?.cause?.name || null,
      causaMensagem: erro?.cause?.message || null,
      codigo: erro?.cause?.code || erro?.code || null
    };

    console.error(
      "Falha detalhada na conexão Supabase:",
      JSON.stringify(diagnostico)
    );

    return res.status(502).json({
      conectado: false,
      diagnostico
    });
  }
});

// EXTRAÇÃO DE TEXTO DOS PDFS
async function extrairTextoPDF(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const documento = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false
  }).promise;

  let textoCompleto = "";

  try {
    const total = Math.min(documento.numPages, 15);

    for (let numero = 1; numero <= total; numero++) {
      const pagina = await documento.getPage(numero);
      const conteudo = await pagina.getTextContent();

      const textoPagina = conteudo.items
        .map(item => item.str || "")
        .join(" ");

      textoCompleto +=
        "\n\n--- PÁGINA " + numero + " ---\n" + textoPagina;
    }
  } finally {
    if (documento && typeof documento.cleanup === "function") {
      await documento.cleanup();
    }
  }

  return textoCompleto.trim().slice(0, 9000);
}

// ANÁLISE DOCUMENTAL COM GROQ
app.post("/api/analyze", upload.single("edital"), async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ erro: "Autenticação indisponível no momento." });
    const acesso = await validarAcesso(req);
    if (acesso.erro) return res.status(acesso.status).json({ erro: acesso.erro });

    if (!GROQ_API_KEY) {
      return res.status(500).json({
        erro: "Chave GROQ_API_KEY não encontrada no ambiente."
      });
    }

    const {
      imovel = "",
      estado = "",
      municipio = "",
      area = "",
      car = "",
      matricula = "",
      lance = "",
      texto = ""
    } = req.body || {};

    let textoPDF = "";

    if (req.file) {
      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({
          erro: "Envie um arquivo PDF válido."
        });
      }

      textoPDF = await extrairTextoPDF(req.file.buffer);
    }

    if (!textoPDF && !texto.trim()) {
      return res.status(400).json({
        erro: "Não encontrei texto no PDF. Este arquivo pode ser digitalizado como imagem. Por enquanto, envie um PDF com texto selecionável ou preencha as observações."
      });
    }

    const prompt = `
Você é o analista documental do LANCE RURAL IA,
especializado em imóveis rurais vendidos em leilões no Brasil.

Faça uma análise preliminar cuidadosa. Não invente informações.
Não afirme que consultou cartório, CAR, SIGEF, INCRA,
tribunais ou bases oficiais sem comprovação.

Diferencie fatos encontrados, possíveis riscos,
informações ausentes e verificações ainda necessárias.

DADOS INFORMADOS:
Imóvel: ${imovel}
Estado: ${estado}
Município: ${municipio}
Área: ${area}
CAR: ${car}
Matrícula: ${matricula}
Lance pretendido: ${lance}
Observações: ${texto}

TEXTO EXTRAÍDO DO PDF:
${textoPDF.slice(0, 70000)}

ESTRUTURE O RELATÓRIO:
1. Resumo do imóvel e leilão.
2. Informações documentais encontradas.
3. Matrícula e titularidade, se houver dados.
4. Área e localização.
5. Riscos jurídicos e de ocupação.
6. Riscos ambientais e cadastrais.
7. Análise financeira, se houver valores.
8. Documentos e consultas que faltam.
9. Providências antes do lance.
10. Conclusão preliminar e nível de atenção.

Se não houver informação, escreva:
"Não identificado no material enviado".

Não garanta segurança ou lucro. Explique que a análise
não substitui a avaliação de profissionais habilitados.
Responda em português brasileiro.
`;

    const resposta = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODELO,
          messages: [
            {
              role: "system",
              content: "Você é um analista documental cuidadoso e transparente."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 6000
        })
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      console.error(
        "Erro Groq:",
        dados.error?.message || resposta.status
      );

      return res.status(502).json({
        erro: "A IA não respondeu. Verifique o modelo e os limites da conta Groq."
      });
    }

    const analise = dados.choices?.[0]?.message?.content?.trim();

    if (!analise) {
      return res.status(502).json({
        erro: "A IA não retornou uma análise."
      });
    }

    const { error: erroRegistro } = await supabaseAdmin
      .from("analysis_usage")
      .insert({ user_id: acesso.user.id, property_name: imovel || "Imóvel sem identificação" });
    if (erroRegistro) {
      console.error("Erro ao registrar uso da análise:", erroRegistro.message);
      return res.status(500).json({ erro: "A análise foi gerada, mas não foi possível registrar o consumo. Contate o suporte." });
    }

    return res.json({ sucesso: true, analise });

  } catch (erro) {
    console.error("Falha na análise:", erro.message);

    return res.status(500).json({
      erro: "Falha ao analisar o documento: " + erro.message
    });
  }
});

// WEBHOOK DA KIWIFY
// A Kiwify usa o token como chave HMAC-SHA1 e envia a assinatura em ?signature=...
app.post("/api/kiwify-webhook", async (req, res) => {
  try {
    const segredo = process.env.KIWIFY_WEBHOOK_TOKEN;
    const assinaturaRecebida = String(req.query.signature || "").trim().toLowerCase();

    if (!segredo) {
      console.error("Webhook Kiwify: KIWIFY_WEBHOOK_TOKEN não configurado.");
      return res.status(503).json({ recebido: false, erro: "Webhook ainda não configurado." });
    }

    if (!req.rawBody || !assinaturaRecebida) {
      return res.status(401).json({ recebido: false, erro: "Assinatura ausente." });
    }

    const assinaturaEsperada = crypto.createHmac("sha1", segredo).update(req.rawBody).digest("hex");
    const recebido = Buffer.from(assinaturaRecebida, "hex");
    const esperado = Buffer.from(assinaturaEsperada, "hex");
    if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
      console.warn("Webhook Kiwify recusado: assinatura inválida.");
      return res.status(401).json({ recebido: false, erro: "Assinatura inválida." });
    }

    const evento = req.body;
    if (!evento || typeof evento !== "object" || Array.isArray(evento)) {
      return res.status(400).json({ recebido: false, erro: "Dados inválidos." });
    }

    const emailTeste = String(evento.Customer?.email || "").toLowerCase();
    const produtoTeste = String(evento.Product?.product_name || "").toLowerCase();
    if (emailTeste.endsWith("@example.com") || produtoTeste.includes("example product")) {
      console.log("Webhook Kiwify: evento de teste recebido; nenhuma assinatura alterada.");
      return res.status(200).json({ recebido: true, teste: true });
    }

    if (!supabaseAdmin) {
      console.error("Webhook Kiwify: Supabase Admin não configurado.");
      return res.status(503).json({ recebido: false, erro: "Integração indisponível." });
    }

    const pedido = String(evento.order_id || "").trim();
    const statusPedido = String(evento.order_status || "").toLowerCase();
    const tipoEvento = String(evento.webhook_event_type || "").toLowerCase();
    const email = String(evento.Customer?.email || "").trim().toLowerCase();
    const produto = String(evento.Product?.product_name || "");
    const produtoId = String(evento.Product?.product_id || "");

    if (!pedido || !email) {
      return res.status(400).json({ recebido: false, erro: "Pedido ou e-mail do comprador ausente." });
    }

    const eventoEstorno = statusPedido.includes("refund") || statusPedido.includes("chargeback") ||
      tipoEvento.includes("refund") || tipoEvento.includes("chargeback") || tipoEvento.includes("charged_back");
    const eventoCancelamento = statusPedido.includes("cancel") || tipoEvento.includes("cancel");
    const eventoAprovado = statusPedido === "paid" || statusPedido === "approved" ||
      tipoEvento === "order_approved" || tipoEvento === "subscription_renewed";
    const eventoAtrasado = statusPedido.includes("late") || tipoEvento.includes("late") || tipoEvento.includes("overdue");

    if (!eventoEstorno && !eventoCancelamento && !eventoAprovado && !eventoAtrasado) {
      return res.status(200).json({ recebido: true, mensagem: "Evento recebido; nenhum acesso foi alterado." });
    }

    let usuario = null;
    for (let pagina = 1; pagina <= 10; pagina++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: pagina, perPage: 1000 });
      if (error) throw error;
      usuario = (data.users || []).find(u => String(u.email || "").toLowerCase() === email) || null;
      if (usuario || !data.users || data.users.length < 1000) break;
    }
    if (!usuario) {
      return res.status(409).json({
        recebido: false,
        erro: "Conta não encontrada. O comprador deve criar a conta com o mesmo e-mail da compra; depois reenvie o webhook."
      });
    }

    const nomeProduto = produto.toLowerCase();
    const premium = nomeProduto.includes("premium") ||
      (process.env.KIWIFY_PREMIUM_PRODUCT_ID && produtoId === process.env.KIWIFY_PREMIUM_PRODUCT_ID);
    const essencial = nomeProduto.includes("essencial") ||
      (process.env.KIWIFY_ESSENCIAL_PRODUCT_ID && produtoId === process.env.KIWIFY_ESSENCIAL_PRODUCT_ID);
    if (!premium && !essencial) {
      return res.status(200).json({ recebido: true, assinatura_atualizada: false, mensagem: "Produto ainda não mapeado." });
    }

    const plano = premium ? "Premium" : "Essencial";
    const limite = premium ? 30 : 10;
    const acessoRevogado = eventoEstorno || eventoCancelamento || eventoAtrasado;
    const agora = new Date();
    const fimPeriodo = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);

    const { data: assinaturaAtual, error: erroBusca } = await supabaseAdmin
      .from("subscriptions").select("user_id,last_transaction_id").eq("user_id", usuario.id).maybeSingle();
    if (erroBusca) throw erroBusca;
    if (assinaturaAtual?.last_transaction_id === pedido && !acessoRevogado) {
      return res.status(200).json({ recebido: true, assinatura_atualizada: false, mensagem: "Pedido já processado." });
    }

    const dadosAssinatura = {
      user_id: usuario.id, plan: plano,
      status: acessoRevogado ? (eventoAtrasado ? "past_due" : "canceled") : "active",
      analyses_limit: limite, period_start: agora.toISOString(),
      period_end: acessoRevogado ? agora.toISOString() : fimPeriodo.toISOString(),
      provider: "kiwify", last_transaction_id: pedido
    };
    const resultado = assinaturaAtual
      ? await supabaseAdmin.from("subscriptions").update(dadosAssinatura).eq("user_id", usuario.id)
      : await supabaseAdmin.from("subscriptions").insert(dadosAssinatura);
    if (resultado.error) throw resultado.error;

    console.log("Webhook Kiwify processado:", { pedido, plano, status: dadosAssinatura.status, evento: tipoEvento });
    return res.status(200).json({ recebido: true, assinatura_atualizada: true, plano, status: dadosAssinatura.status });
  } catch (erro) {
    console.error("ERRO WEBHOOK KIWIFY:", erro?.message || erro);
    return res.status(500).json({ recebido: false, erro: "Falha ao processar webhook." });
  }
});

// INICIALIZAÇÃO DO SERVIDOR
app.listen(PORTA, () => {
  console.log("====================================");
  console.log("          LANCE RURAL IA");
  console.log("====================================");
  console.log("Servidor iniciado na porta: " + PORTA);
  console.log("Provedor: Groq");
  console.log("Modelo: " + MODELO);
  console.log("Chave Groq configurada: " + Boolean(GROQ_API_KEY));
  console.log("Supabase configurado: " + Boolean(supabase));
  console.log("====================================");
});
