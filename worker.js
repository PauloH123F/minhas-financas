/**
 * Minhas Finanças — backend inicial
 * Cloudflare Worker + Mercado Pago Webhook
 *
 * Fase 1:
 * - recebe Webhooks do Mercado Pago
 * - valida a assinatura x-signature (quando configurada)
 * - consulta o pagamento diretamente na API do Mercado Pago
 * - considera aprovado somente quando status === "approved"
 * - registra o resultado em Cloudflare KV
 * - disponibiliza uma página de confirmação por /acesso?payment_id=...
 *
 * IMPORTANTE:
 * 1) Nunca coloque o Access Token do Mercado Pago neste arquivo.
 * 2) Configure MP_ACCESS_TOKEN e, se disponível no seu painel,
 *    MP_WEBHOOK_SECRET como secrets do Worker.
 * 3) O webhook público será:
 *    https://SEU-WORKER.workers.dev/webhook/mercadopago
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "minhas-financas-backend",
        version: "1.0.0",
      });
    }

    // Endpoint público do Webhook
    if (request.method === "POST" && url.pathname === "/webhook/mercadopago") {
      return handleMercadoPagoWebhook(request, env);
    }

    // Página para confirmar/liberar acesso após o checkout.
    // Ex.: /acesso?payment_id=123456789
    if (request.method === "GET" && url.pathname === "/acesso") {
      return handleAccessPage(url, env);
    }

    // Consulta simples de status (útil para testes)
    if (request.method === "GET" && url.pathname === "/status") {
      const paymentId = url.searchParams.get("payment_id");
      if (!paymentId) return json({ ok: false, error: "payment_id obrigatório" }, 400);

      const record = await env.PAYMENTS.get(`payment:${paymentId}`, "json");
      return json({
        ok: true,
        payment_id: paymentId,
        payment: record || null,
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleMercadoPagoWebhook(request, env) {
  // Leia o corpo sem alterá-lo para permitir futuras validações de assinatura.
  const bodyText = await request.text();

  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // Mercado Pago pode enviar notificações em formatos diferentes.
  }

  // Identifica o ID do pagamento em formatos comuns de Webhook.
  const url = new URL(request.url);
  const paymentId =
    body?.data?.id ||
    body?.id ||
    url.searchParams.get("data.id") ||
    url.searchParams.get("id");

  // Responda rápido ao Mercado Pago mesmo se a notificação não tiver payment_id.
  if (!paymentId) {
    return json({ ok: true, received: true, message: "Notificação recebida sem payment_id." });
  }

  if (!env.MP_ACCESS_TOKEN) {
    return json(
      { ok: false, error: "MP_ACCESS_TOKEN ainda não configurado no Worker." },
      500
    );
  }

  // Segurança adicional: quando MP_WEBHOOK_SECRET estiver configurado,
  // valida a assinatura enviada pelo Mercado Pago.
  if (env.MP_WEBHOOK_SECRET) {
    const valid = await validateMercadoPagoSignature(request, body, paymentId, env.MP_WEBHOOK_SECRET);
    if (!valid) {
      return json({ ok: false, error: "Assinatura do webhook inválida." }, 401);
    }
  }

const eventType = url.searchParams.get("type") || body?.type;

const apiUrl =
  eventType === "subscription_authorized_payment"
    ? `https://api.mercadopago.com/authorized_payments/${encodeURIComponent(paymentId)}`
    : eventType === "subscription_preapproval"
      ? `https://api.mercadopago.com/preapproval/${encodeURIComponent(paymentId)}`
      : `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`;

const mpResponse = await fetch(
  apiUrl,
    {
      headers: {
        Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!mpResponse.ok) {
    const errorText = await mpResponse.text();
    console.error("Mercado Pago API:", mpResponse.status, errorText);
    return json({ ok: false, error: "Não foi possível consultar o pagamento." }, 502);
  }

  const payment = await mpResponse.json();

  // Só libera acesso para pagamento efetivamente aprovado.
  const approved = payment?.status === "approved";

  const record = {
    payment_id: String(payment.id),
    status: payment.status || null,
    status_detail: payment.status_detail || null,
    amount: payment.transaction_amount || null,
    currency: payment.currency_id || null,
    payer_email: payment.payer?.email || null,
    external_reference: payment.external_reference || null,
    date_approved: payment.date_approved || null,
    updated_at: new Date().toISOString(),
    approved,
  };

  // KV é usado para guardar o estado do pagamento.
  await env.PAYMENTS.put(
    `payment:${payment.id}`,
    JSON.stringify(record),
    { expirationTtl: 60 * 60 * 24 * 400 }
  );

  return json({
    ok: true,
    received: true,
    payment_id: payment.id,
    approved,
  });
}

async function handleAccessPage(url, env) {
  const paymentId = url.searchParams.get("payment_id");

  if (!paymentId) {
    return htmlPage("Pagamento não informado", `
      <h1>Minhas Finanças</h1>
      <p>Não encontramos o identificador do pagamento.</p>
    `, 400);
  }

  const record = await env.PAYMENTS.get(`payment:${paymentId}`, "json");

  if (!record || !record.approved) {
    return htmlPage("Pagamento em confirmação", `
      <h1>Pagamento em confirmação</h1>
      <p>O Mercado Pago ainda não confirmou este pagamento.</p>
      <p>Assim que a confirmação chegar, o acesso poderá ser liberado.</p>
    `);
  }

  // Fase 1: usamos uma URL fixa de acesso ao app.
  // Na próxima etapa podemos trocar por um link individual/tokenizado.
  const appUrl = "https://pauloh123f.github.io/minhas-financas/";

  return htmlPage("Pagamento confirmado", `
    <h1>Pagamento confirmado! ✅</h1>
    <p>Seu acesso ao <strong>Minhas Finanças Pro</strong> foi confirmado.</p>
    <p><a class="button" href="${appUrl}">Acessar o Minhas Finanças</a></p>
  `);
}

async function validateMercadoPagoSignature(request, body, paymentId, secret) {
  const xSignature = request.headers.get("x-signature");
  const xRequestId = request.headers.get("x-request-id");

  if (!xSignature || !xRequestId) return false;

  // Formato esperado:
  // x-signature: ts=...,v1=...
  const parts = Object.fromEntries(
    xSignature.split(",").map((item) => {
      const [key, value] = item.split("=");
      return [key?.trim(), value?.trim()];
    })
  );

  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // Mercado Pago usa data.id em minúsculas na assinatura.
  const manifest = `id:${String(paymentId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;

  const expected = await hmacSha256Hex(secret, manifest);
  return timingSafeEqual(expected, v1);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function htmlPage(title, content, status = 200) {
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:Arial,sans-serif;background:#07111f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{max-width:520px;width:100%;background:#102033;border:1px solid #24405e;border-radius:24px;padding:32px;box-sizing:border-box;text-align:center}
h1{font-size:30px;margin-top:0}
p{font-size:18px;line-height:1.5;color:#c8d4e2}
.button{display:inline-block;background:#20c878;color:#04120b;text-decoration:none;font-weight:700;padding:15px 22px;border-radius:14px;margin-top:12px}
</style>
</head>
<body><div class="card">${content}</div></body>
</html>`, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
