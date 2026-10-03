/**
 * MINHAS FINANÇAS PRO
 * Cloudflare Worker + Mercado Pago + Cloudflare KV
 * Versão 3.0.1
 */

const APP_URL = "https://pauloh123f.github.io/minhas-financas/";
const APP_ORIGIN = "https://pauloh123f.github.io";
const CHECKOUT_URL = "https://mpago.la/33i4rah";
const KV_TTL = 60 * 60 * 24 * 400;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return corsJson({
        ok: true,
        service: "minhas-financas-backend",
        version: "3.0.1",
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
      return handlePaymentStatus(url, env);
    }

    if (request.method === "GET" && url.pathname === "/pro/status") {
      return handleProStatus(url, env);
    }

    if (request.method === "GET" && url.pathname === "/checkout") {
      return Response.redirect(CHECKOUT_URL, 302);
    }

    return corsJson(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },
};


/* =========================================================
   WEBHOOK MERCADO PAGO
========================================================= */

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
    "Mercado Pago webhook:",
    eventType,
    resourceId || "sem-id"
  );

  if (!resourceId) {
    return corsJson({
      ok: true,
      received: true,
      type: eventType,
      message: "Webhook recebido sem resource_id.",
    });
  }

  if (!env.MP_ACCESS_TOKEN) {
    console.error("MP_ACCESS_TOKEN não configurado.");

    return corsJson(
      {
        ok: false,
        error: "Configuração Mercado Pago ausente.",
      },
      500
    );
  }

  if (env.MP_WEBHOOK_SECRET) {
    const valid = await validateMercadoPagoSignature(
      request,
      resourceId,
      env.MP_WEBHOOK_SECRET
    );

    if (!valid) {
      console.error("Assinatura webhook inválida.");

      return corsJson(
        {
          ok: false,
          error: "Assinatura do webhook inválida.",
        },
        401
      );
    }
  }

  if (eventType === "payment") {
    return processPayment(resourceId, env);
  }

  if (eventType === "subscription_preapproval") {
    return processSubscription(resourceId, env);
  }

  if (eventType === "subscription_authorized_payment") {
    return processAuthorizedPayment(resourceId, env);
  }

  if (eventType === "subscription_preapproval_plan") {
    return corsJson({
      ok: true,
      received: true,
      type: eventType,
      resource_id: String(resourceId),
    });
  }

  return corsJson({
    ok: true,
    received: true,
    type: eventType,
    resource_id: String(resourceId),
  });
}


/* =========================================================
   PAGAMENTO
========================================================= */

async function processPayment(paymentId, env) {
  const result = await mercadoPagoGet(
    `/v1/payments/${encodeURIComponent(paymentId)}`,
    env
  );

  if (result.status === 404) {
    return corsJson({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "payment",
      resource_id: String(paymentId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro pagamento MP:",
      result.status,
      result.text
    );

    return corsJson(
      {
        ok: false,
        error: "Erro temporário consultando pagamento.",
      },
      502
    );
  }

  const payment = result.data;

  const approved = payment?.status === "approved";

  const email = normalizeEmail(payment?.payer?.email);

  const record = {
    payment_id: String(payment.id),
    status: payment.status || null,
    status_detail: payment.status_detail || null,
    amount: payment.transaction_amount ?? null,
    currency: payment.currency_id || null,
    payer_email: email || null,
    external_reference: payment.external_reference || null,
    date_approved: payment.date_approved || null,
    updated_at: new Date().toISOString(),
    approved,
  };

  await env.PAYMENTS.put(
    `payment:${payment.id}`,
    JSON.stringify(record),
    {
      expirationTtl: KV_TTL,
    }
  );

  if (email) {
    await env.PAYMENTS.put(
      `payment-email:${email}`,
      JSON.stringify(record),
      {
        expirationTtl: KV_TTL,
      }
    );
  }

  return corsJson({
    ok: true,
    received: true,
    type: "payment",
    payment_id: String(payment.id),
    status: payment.status || null,
    approved,
  });
}


/* =========================================================
   ASSINATURA
========================================================= */

async function processSubscription(subscriptionId, env) {
  const result = await mercadoPagoGet(
    `/preapproval/${encodeURIComponent(subscriptionId)}`,
    env
  );

  if (result.status === 404) {
    return corsJson({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "subscription_preapproval",
      resource_id: String(subscriptionId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro assinatura MP:",
      result.status,
      result.text
    );

    return corsJson(
      {
        ok: false,
        error: "Erro temporário consultando assinatura.",
      },
      502
    );
  }

  const subscription = result.data;

  const email = normalizeEmail(subscription?.payer_email);

  const active = subscription?.status === "authorized";

  const record = {
    subscription_id: String(subscription.id),
    status: subscription.status || null,
    active,
    payer_email: email || null,

    payer_id: subscription.payer_id
      ? String(subscription.payer_id)
      : null,

    preapproval_plan_id:
      subscription.preapproval_plan_id || null,

    external_reference:
      subscription.external_reference || null,

    reason: subscription.reason || null,

    date_created:
      subscription.date_created || null,

    updated_at: new Date().toISOString(),
  };

  await env.PAYMENTS.put(
    `subscription:${subscription.id}`,
    JSON.stringify(record),
    {
      expirationTtl: KV_TTL,
    }
  );

  if (email) {
    await env.PAYMENTS.put(
      `subscription-email:${email}`,
      JSON.stringify(record),
      {
        expirationTtl: KV_TTL,
      }
    );
  }

  return corsJson({
    ok: true,
    received: true,
    type: "subscription_preapproval",
    subscription_id: String(subscription.id),
    status: subscription.status || null,
    active,
  });
}


/* =========================================================
   PAGAMENTO RECORRENTE DA ASSINATURA
========================================================= */

async function processAuthorizedPayment(invoiceId, env) {
  const result = await mercadoPagoGet(
    `/authorized_payments/${encodeURIComponent(invoiceId)}`,
    env
  );

  if (result.status === 404) {
    return corsJson({
      ok: true,
      received: true,
      simulated_or_not_found: true,
      type: "subscription_authorized_payment",
      resource_id: String(invoiceId),
    });
  }

  if (!result.ok) {
    console.error(
      "Erro fatura MP:",
      result.status,
      result.text
    );

    return corsJson(
      {
        ok: false,
        error: "Erro temporário consultando fatura.",
      },
      502
    );
  }

  const invoice = result.data;

  const paymentId = invoice?.payment?.id
    ? String(invoice.payment.id)
    : null;

  const paymentApproved =
    invoice?.payment?.status === "approved";

  const record = {
    authorized_payment_id: String(invoice.id),
    preapproval_id: invoice.preapproval_id || null,
    external_reference: invoice.external_reference || null,
    status: invoice.status || null,
    summarized: invoice.summarized || null,
    amount: invoice.transaction_amount ?? null,
    currency: invoice.currency_id || null,
    payment_id: paymentId,
    payment_status: invoice?.payment?.status || null,
    payment_status_detail:
      invoice?.payment?.status_detail || null,
    payment_approved: paymentApproved,
    updated_at: new Date().toISOString(),
  };

  await env.PAYMENTS.put(
    `invoice:${invoice.id}`,
    JSON.stringify(record),
    {
      expirationTtl: KV_TTL,
    }
  );

  if (invoice.preapproval_id) {
    await env.PAYMENTS.put(
      `last-invoice:${invoice.preapproval_id}`,
      JSON.stringify(record),
      {
        expirationTtl: KV_TTL,
      }
    );
  }

  if (paymentId) {
    const paymentResult = await mercadoPagoGet(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      env
    );

    if (paymentResult.ok) {
      const payment = paymentResult.data;

      const email = normalizeEmail(payment?.payer?.email);

      const approved = payment?.status === "approved";

      const paymentRecord = {
        payment_id: String(payment.id),
        status: payment.status || null,
        status_detail: payment.status_detail || null,
        amount: payment.transaction_amount ?? null,
        currency: payment.currency_id || null,
        payer_email: email || null,
        external_reference:
          payment.external_reference || null,
        date_approved: payment.date_approved || null,
        subscription_id:
          invoice.preapproval_id || null,
        updated_at: new Date().toISOString(),
        approved,
      };

      await env.PAYMENTS.put(
        `payment:${payment.id}`,
        JSON.stringify(paymentRecord),
        {
          expirationTtl: KV_TTL,
        }
      );

      if (email) {
        await env.PAYMENTS.put(
          `payment-email:${email}`,
          JSON.stringify(paymentRecord),
          {
            expirationTtl: KV_TTL,
          }
        );
      }
    }
  }

  return corsJson({
    ok: true,
    received: true,
    type: "subscription_authorized_payment",
    resource_id: String(invoice.id),
    subscription_id: invoice.preapproval_id || null,
    payment_id: paymentId,
    payment_approved: paymentApproved,
  });
}


/* =========================================================
   STATUS PRO
========================================================= */

async function handleProStatus(url, env) {
  const email = normalizeEmail(
    url.searchParams.get("email")
  );

  if (!email) {
    return corsJson(
      {
        ok: false,
        pro: false,
        error: "E-mail obrigatório.",
      },
      400
    );
  }

  const subscription = await env.PAYMENTS.get(
    `subscription-email:${email}`,
    "json"
  );

  const payment = await env.PAYMENTS.get(
    `payment-email:${email}`,
    "json"
  );

  const subscriptionActive =
    subscription?.status === "authorized";

  const paymentApproved =
    payment?.status === "approved";

  const pro = Boolean(
    subscriptionActive && paymentApproved
  );

  return corsJson({
    ok: true,
    pro,
    subscription_status:
      subscription?.status || null,
    payment_status:
      payment?.status || null,
    subscription_id:
      subscription?.subscription_id || null,
    checked_at: new Date().toISOString(),
  });
}


/* =========================================================
   STATUS PAGAMENTO
========================================================= */

async function handlePaymentStatus(url, env) {
  const paymentId =
    url.searchParams.get("payment_id");

  if (!paymentId) {
    return corsJson(
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

  return corsJson({
    ok: true,
    payment_id: paymentId,
    payment: record || null,
  });
}


/* =========================================================
   PÁGINA DE RETORNO
========================================================= */

async function handleAccessPage(url, env) {
  const paymentId =
    url.searchParams.get("payment_id");

  if (!paymentId) {
    return htmlPage(
      "Assinatura recebida",
      `
      <h1>Minhas Finanças</h1>
      <div class="success">✓</div>
      <h2>Retorno recebido</h2>

      <p>
        O Mercado Pago está processando sua assinatura.
      </p>

      <p>
        Volte ao aplicativo e informe o mesmo e-mail
        utilizado na assinatura para verificar seu acesso Pro.
      </p>

      <p>
        <a class="button" href="${APP_URL}">
          Voltar ao Minhas Finanças
        </a>
      </p>
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
      <h1>Minhas Finanças</h1>
      <h2>Pagamento em confirmação</h2>

      <p>
        O Mercado Pago ainda não confirmou este pagamento.
      </p>

      <p>
        Assim que a confirmação chegar, o acesso Pro poderá
        ser identificado pelo aplicativo.
      </p>

      <p>
        <a class="button" href="${APP_URL}">
          Voltar ao aplicativo
        </a>
      </p>
      `
    );
  }

  return htmlPage(
    "Pagamento confirmado",
    `
    <h1>Minhas Finanças</h1>
    <div class="success">✓</div>
    <h2>Pagamento confirmado!</h2>

    <p>
      Seu pagamento foi confirmado pelo Mercado Pago.
    </p>

    <p>
      Volte ao aplicativo para verificar seu acesso Pro.
    </p>

    <p>
      <a class="button" href="${APP_URL}">
        Acessar Minhas Finanças
      </a>
    </p>
    `
  );
}


/* =========================================================
   API MERCADO PAGO
========================================================= */

async function mercadoPagoGet(path, env) {
  const response = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.MP_ACCESS_TOKEN}`,

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


/* =========================================================
   VALIDAÇÃO DA ASSINATURA DO WEBHOOK
========================================================= */

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

  const parts = {};

  for (const item of xSignature.split(",")) {
    const index = item.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      item.slice(0, index).trim();

    const value =
      item.slice(index + 1).trim();

    if (key) {
      parts[key] = value;
    }
  }

  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) {
    return false;
  }

  const manifest =
    `id:${String(resourceId).toLowerCase()};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const expected = await hmacSha256Hex(
    secret,
    manifest
  );

  return timingSafeEqual(expected, v1);
}


/* =========================================================
   HMAC
========================================================= */

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

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return [...new Uint8Array(signature)]
    .map(
      (b) =>
        b.toString(16).padStart(2, "0")
    )
    .join("");
}


function timingSafeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
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


/* =========================================================
   HELPERS
========================================================= */

function normalizeEmail(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase();
}


/*
 * IMPORTANTE:
 * O Origin do GitHub Pages é:
 * https://pauloh123f.github.io
 *
 * O caminho /minhas-financas/ NÃO faz parte do Origin.
 */
function corsHeaders() {
  return {
    "access-control-allow-origin":
      APP_ORIGIN,

    "access-control-allow-methods":
      "GET,POST,OPTIONS",

    "access-control-allow-headers":
      "Content-Type",
  };
}


function corsJson(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=UTF-8",

        ...corsHeaders(),
      },
    }
  );
}


function corsResponse(body, status = 200) {
  return new Response(body, {
    status,

    headers: {
      ...corsHeaders(),

      "access-control-max-age":
        "86400",
    },
  });
}


function htmlPage(
  title,
  content,
  status = 200
) {
  return new Response(
    `<!doctype html>
<html lang="pt-BR">

<head>
<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>${escapeHtml(title)}</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #07111f;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  margin: 0;
  padding: 24px;
}

.card {
  max-width: 520px;
  width: 100%;
  background: #102033;
  border: 1px solid #24405e;
  border-radius: 24px;
  padding: 32px;
  box-sizing: border-box;
  text-align: center;
}

h1 {
  font-size: 30px;
  margin-top: 0;
}

h2 {
  font-size: 23px;
}

p {
  font-size: 18px;
  line-height: 1.5;
  color: #c8d4e2;
}

.success {
  width: 72px;
  height: 72px;
  margin: 18px auto;
  border-radius: 50%;
  background: #20c878;
  color: #04120b;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  font-weight: 700;
}

.button {
  display: inline-block;
  background: #20c878;
  color: #04120b;
  text-decoration: none;
  font-weight: 700;
  padding: 15px 22px;
  border-radius: 14px;
  margin-top: 12px;
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
