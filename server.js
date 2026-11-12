
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORTA = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODELO = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.get("/vendas.html", (req, res) =>
  res.sendFile(path.join(__dirname, "vendas.html"))
);

app.get("/api/status", (req, res) => {
  res.json({
    funcionando: true,
    provedor: "Groq",
    modelo: MODELO,
    chaveConfigurada: Boolean(GROQ_API_KEY),
    supabaseConfigurado: Boolean(supabase)
  });
});

// TESTE DE CONEXÃO COM SUPABASE
app.get("/api/supabase-status", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({
      conectado: false,
      erro: "Variáveis do Supabase não configuradas."
    });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);

    if (error) throw error;

    return res.json({
      conectado: true,
      mensagem: "Comunicação com Supabase funcionando."
    });

  } catch (erro) {
    console.error("Erro Supabase:", erro.message);

    return res.status(500).json({
      conectado: false,
      erro: "Falha na comunicação com Supabase."
    });
  }
});

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

app.post("/api/analyze", upload.single("edital"), async (req, res) => {
  try {
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
      console.error("Erro Groq:", dados.error?.message || resposta.status);

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

    return res.json({ sucesso: true, analise });

  } catch (erro) {
    console.error("Falha na análise:", erro.message);

    return res.status(500).json({
      erro: "Falha ao analisar o documento: " + erro.message
    });
  }
});

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
