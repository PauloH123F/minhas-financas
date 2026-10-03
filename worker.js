/**
 * Minhas Finanças — Backend
 * Cloudflare Worker + Mercado Pago + Cloudflare KV
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "minhas-financas-backend",
        version: "2.0.0",
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/webhook/mercadopago"
    ) {
      return handleMercadoPagoWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/acesso") {
      return handleAccessPage(url, env);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return handleStatus(url, env);
    }

    return new Response("Not found", { status: 404 });
  },
};


async function handleMercadoPagoWebhook(request, env) {
  const bodyText = await request.text();

  let body = {};

  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }

  const url = new URL(request.url);

  const resourceId =
    body?.data?.id ||
    body?.id ||
    url.searchParams.get("data.id") ||
    url.searchParams.get("id");

  const eventType =
    url.searchParams.get("type") ||
    body?.type ||
    "unknown";

  console.log(
    "Webhook Mercado Pago:",
    eventType,
    resourceId || "sem-id"
  );

  /*
   * Algumas notificações podem não trazer um ID utilizável.
   * Confirmamos o recebimento para evitar retries desnecessários.
   */
  if (!resourceId) {
    return json({
      ok: true,
      received: true,
      type: eventType,
      message: "Webhook recebido sem resource_id.",
    });
  }

  if (!env.MP_ACCESS_TOKEN) {
    console.error("MP_ACCESS_TOKEN não configurado.");

    return json(
      {
        ok: false,
        error: "Configuração do Mercado Pago ausente.",
      },
      500
    );
  }

  /*
   * Validação da assinatura do webhook.
   */
  if (env.MP_WEBHOOK_SECRET) {
    const valid = await validateMercadoPagoSignature(
      request,
      resourceId,
      env.MP_WEBHOOK_SECRET
    );

    if (!valid) {
      console.error("Assinatura do webhook inválida.");

      return json(
        {
          ok: false,
          error: "Assinatura do webhook inválida.",
        },
        401
      );
    }
  }

  /*
   * EVENTO: PAGAMENTO
   *
   * Este é o evento que efetivamente pode liberar acesso.
   */
  if (eventType === "payment") {
    return processPayment(resourceId, env);
  }

  /*
   * EVENTO: ASSINATURA
   */
  if (eventType === "subscription_preapproval") {
    return processSubscription(resourceId, env);
  }

  /*
   * EVENTO: FATURA / COBRANÇA RECORRENTE
   */
  if (eventType === "subscription_authorized_payment") {
    return processAuthorizedPayment(resourceId, env);
  }

  /*
   * EVENTO: PLANO
   *
   * Não libera usuário.
   * Apenas confirmamos que recebemos.
   */
  if (eventType === "subscription_preapproval_plan") {
    return json({
      ok: true,
      received: true,
      type: eventType,
      resource_id: String(resourceId),
      message: "Notificação do plano recebida.",
    });
  }

  /*
   * Evento que ainda não utilizamos.
   * Respondemos 200 para confirmar recebimento.
   */
  return json({
    ok: true,
    received: true,
    type: eventType,
    resource_id: String(resourceId),
    message: "Evento recebido.",
  });
}


async function processPayment(paymentId, env) {
  const result = await mercadoPagoGet(
    `/v1/payments/${encodeURIComponent(paymentId)}`,
    env
  );

  /*
   * O simulador do Mercado Pago pode usar um ID fictício.
   * Nesse caso a API retorna 404.
   *
   * O webhook funcionou; simplesmente não existe um pagamento
   * real para consultar.
   */
  if (result.status === 404) {
    console.log(
      "Pagamento não encontrado. Possível ID do simulador:",
      paymentId
    );

    return json({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "payment",
      resource_id: String(paymentId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro consultando pagamento:",
      result.status,
      result.text
    );

    return json(
      {
        ok: false,
        error: "Erro temporário consultando o Mercado Pago.",
      },
      502
    );
  }

  const payment = result.data;

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

  await env.PAYMENTS.put(
    `payment:${payment.id}`,
    JSON.stringify(record),
    {
      expirationTtl: 60 * 60 * 24 * 400,
    }
  );

  /*
   * Também guardamos o último pagamento pelo e-mail.
   * Isso será útil na próxima etapa para liberar o cliente
   * sem depender do payment_id na URL.
   */
  if (payment.payer?.email) {
    const email = String(payment.payer.email)
      .trim()
      .toLowerCase();

    await env.PAYMENTS.put(
      `email:${email}`,
      JSON.stringify(record),
      {
        expirationTtl: 60 * 60 * 24 * 400,
      }
    );
  }

  return json({
    ok: true,
    received: true,
    type: "payment",
    payment_id: String(payment.id),
    status: payment.status || null,
    approved,
  });
}


async function processSubscription(subscriptionId, env) {
  /*
   * O endpoint individual é adequado quando temos
   * o ID específico da assinatura.
   */
  const result = await mercadoPagoGet(
    `/preapproval/${encodeURIComponent(subscriptionId)}`,
    env
  );

  if (result.status === 404) {
    console.log(
      "Assinatura não encontrada. Possível ID do simulador:",
      subscriptionId
    );

    return json({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "subscription_preapproval",
      resource_id: String(subscriptionId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro consultando assinatura:",
      result.status,
      result.text
    );

    return json(
      {
        ok: false,
        error: "Erro temporário consultando assinatura.",
      },
      502
    );
  }

  const subscription = result.data;

  const record = {
    subscription_id: String(subscription.id),
    status: subscription.status || null,
    payer_email: subscription.payer_email || null,
    external_reference:
      subscription.external_reference || null,
    preapproval_plan_id:
      subscription.preapproval_plan_id || null,
    reason: subscription.reason || null,
    updated_at: new Date().toISOString(),
  };

  await env.PAYMENTS.put(
    `subscription:${subscription.id}`,
    JSON.stringify(record),
    {
      expirationTtl: 60 * 60 * 24 * 400,
    }
  );

  return json({
    ok: true,
    received: true,
    type: "subscription_preapproval",
    subscription_id: String(subscription.id),
    status: subscription.status || null,
  });
}


async function processAuthorizedPayment(invoiceId, env) {
  const result = await mercadoPagoGet(
    `/authorized_payments/${encodeURIComponent(invoiceId)}`,
    env
  );

  if (result.status === 404) {
    console.log(
      "Fatura não encontrada. Possível ID do simulador:",
      invoiceId
    );

    return json({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "subscription_authorized_payment",
      resource_id: String(invoiceId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro consultando fatura:",
      result.status,
      result.text
    );

    return json(
      {
        ok: false,
        error: "Erro temporário consultando fatura.",
      },
      502
    );
  }

  const invoice = result.data;

  const record = {
    authorized_payment_id: String(invoice.id),
    status: invoice.status || null,
    preapproval_id: invoice.preapproval_id || null,
    payment_id: invoice.payment?.id
      ? String(invoice.payment.id)
      : null,
    updated_at: new Date().toISOString(),
  };

  await env.PAYMENTS.put(
    `invoice:${invoice.id}`,
    JSON.stringify(record),
    {
      expirationTtl: 60 * 60 * 24 * 400,
    }
  );

  return json({
    ok: true,
    received: true,
    type: "subscription_authorized_payment",
    resource_id: String(invoice.id),
    status: invoice.status || null,
  });
}


async function mercadoPagoGet(path, env) {
  const response = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}


async function handleStatus(url, env) {
  const paymentId = url.searchParams.get("payment_id");

  if (!paymentId) {
    return json(
      {
        ok: false,
        error: "payment_id obrigatório",
      },
      400
    );
  }

  const record = await env.PAYMENTS.get(
    `payment:${paymentId}`,
    "json"
  );

  return json({
    ok: true,
    payment_id: paymentId,
    payment: record || null,
  });
}


async function handleAccessPage(url, env) {
  const paymentId = url.searchParams.get("payment_id");

  /*
   * O Mercado Pago pode voltar para /acesso sem acrescentar
   * payment_id. Isso não deve ser apresentado como erro.
   */
  if (!paymentId) {
    return htmlPage(
      "Assinatura recebida",
      `
      <h1>Minhas Finanças</h1>
      <p>Recebemos o retorno da sua assinatura.</p>
      <p>A confirmação do pagamento é feita automaticamente pelo Mercado Pago.</p>
      <p>Assim que o pagamento estiver aprovado, seu acesso poderá ser liberado.</p>
      `
    );
  }

  const record = await env.PAYMENTS.get(
    `payment:${paymentId}`,
    "json"
  );

  if (!record || !record.approved) {
    return htmlPage(
      "Pagamento em confirmação",
      `
      <h1>Pagamento em confirmação</h1>
      <p>O Mercado Pago ainda não confirmou este pagamento.</p>
      <p>Assim que a confirmação chegar, o acesso poderá ser liberado.</p>
      `
    );
  }

  const appUrl =
    "https://pauloh123f.github.io/minhas-financas/";

  return htmlPage(
    "Pagamento confirmado",
    `
    <h1>Pagamento confirmado! ✅</h1>
    <p>Seu acesso ao <strong>Minhas Finanças Pro</strong> foi confirmado.</p>
    <p><a class="button" href="${appUrl}">Acessar o Minhas Finanças</a></p>
    `
  );
}


async function validateMercadoPagoSignature(
  request,
  resourceId,
  secret
) {
  const xSignature =
    request.headers.get("x-signature");

  const xRequestId =
    request.headers.get("x-request-id");

  if (!xSignature || !xRequestId) {
    return false;
  }

  const parts = Object.fromEntries(
    xSignature.split(",").map((item) => {
      const [key, value] = item.split("=");

      return [
        key?.trim(),
        value?.trim(),
      ];
    })
  );

  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) {
    return false;
  }

  const manifest =
    `id:${String(resourceId).toLowerCase()};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const expected =
    await hmacSha256Hex(secret, manifest);

  return timingSafeEqual(expected, v1);
}


async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    );

  return [...new Uint8Array(signature)]
    .map((b) =>
      b.toString(16).padStart(2, "0")
    )
    .join("");
}


function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8",
      },
    }
  );
}


function htmlPage(title, content, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  margin:0;
  padding:24px
}
.card{
  max-width:520px;
  width:100%;
  background:#102033;
  border:1px solid #24405e;
  border-radius:24px;
  padding:32px;
  box-sizing:border-box;
  text-align:center
}
h1{
  font-size:30px;
  margin-top:0
}
p{
  font-size:18px;
  line-height:1.5;
  color:#c8d4e2
}
.button{
  display:inline-block;
  background:#20c878;
  color:#04120b;
  text-decoration:none;
  font-weight:700;
  padding:15px 22px;
  border-radius:14px;
  margin-top:12px
}
</style>
</head>
<body>
<div class="card">
${content}
</div>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type":
          "text/html; charset=UTF-8",
      },
    }
  );
}


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
