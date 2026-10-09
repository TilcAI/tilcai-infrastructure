import { centsToAmount, formatVendisDate, type QrCode } from "./domain.ts";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The whole "bank": one button that pays the QR on screen and sends the payment notification.
 * `qr` is the QR that will be paid; `others` are the rest that are still waiting.
 */
export function simulatorPage(p: { qr: QrCode | null; imagePath: string | null; others: QrCode[]; nonce: string; callbackUrl: string }): string {
  const notify = p.callbackUrl ? `La notificación de pago se envía a ${escapeHtml(p.callbackUrl)}.` : "No hay URL de notificación configurada (QR_MOCK_CALLBACK_URL).";
  const { qr } = p;
  const detail = qr
    ? `<img src="${escapeHtml(p.imagePath ?? "")}" alt="Código QR #${qr.qrId}" width="210" height="210">
      <dl>
        <div><dt>QR</dt><dd>#${qr.qrId}</dd></div>
        <div><dt>Monto</dt><dd>${qr.amountCents > 0 ? `Bs ${centsToAmount(qr.amountCents)}` : "abierto (se pagan Bs 10.00)"}</dd></div>
        <div><dt>Glosa</dt><dd>${escapeHtml(qr.description)}</dd></div>
        <div><dt>Vence</dt><dd>${formatVendisDate(new Date(qr.expiresAt))} (hora de Bolivia)</dd></div>
      </dl>`
    : `<p class="empty">No hay ningún QR pendiente de pago. Pide uno y vuelve a cargar esta página.</p>`;
  const others = p.others.length
    ? `<p class="others">Otros QR pendientes: ${p.others
        .map((o) => `<a href="?qr=${o.qrId}" data-qr="${o.qrId}">#${o.qrId} · Bs ${centsToAmount(o.amountCents)}</a>`)
        .join(" · ")}</p>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Simular depósito · QR Simple (mock)</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7; color: #16202a; font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(92vw, 26rem); padding: 1.75rem; background: #fff; border: 1px solid #d9dee5; border-radius: 12px; text-align: center; }
  .tag { margin: 0 0 .5rem; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: #6a7684; }
  h1 { margin: 0 0 1rem; font-size: 1.4rem; }
  img { display: block; margin: 0 auto 1rem; image-rendering: pixelated; border: 1px solid #d9dee5; }
  dl { margin: 0 0 1.25rem; text-align: left; }
  dl div { display: flex; gap: .75rem; padding: .3rem 0; border-bottom: 1px solid #eef0f3; }
  dt { flex: 0 0 4.2rem; color: #6a7684; }
  dd { margin: 0; overflow-wrap: anywhere; }
  button { width: 100%; padding: .85rem 1rem; border: 0; border-radius: 8px; background: #0b6b4f; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { background: #a9b3bf; cursor: not-allowed; }
  #out { min-height: 1.5rem; margin: 1rem 0 0; }
  #out.ok { color: #0b6b4f; } #out.err { color: #b3261e; }
  .empty { color: #6a7684; } .others { margin: 1rem 0 0; font-size: .85rem; color: #6a7684; }
</style>
</head>
<body>
<main>
  <p class="tag">TilcAI · QR Simple de prueba · no mueve dinero</p>
  <h1>Simular depósito</h1>
  ${detail}
  <button id="pay" type="button"${qr ? ` data-qr="${qr.qrId}"` : " disabled"}>Simular depósito</button>
  <p id="out" role="status" aria-live="polite"></p>
  <p class="others">${notify}</p>
  ${others}
</main>
<script nonce="${p.nonce}">
  const button = document.getElementById("pay");
  const out = document.getElementById("out");
  const key = new URLSearchParams(location.search).get("key");
  const base = location.pathname.replace(/\\/?$/, "/");
  for (const a of document.querySelectorAll("a[data-qr]")) if (key) a.href += "&key=" + encodeURIComponent(key);
  button.addEventListener("click", async () => {
    button.disabled = true;
    out.className = "";
    out.textContent = "Enviando el depósito…";
    try {
      const res = await fetch(base + "simulate/deposit" + (key ? "?key=" + encodeURIComponent(key) : ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qr_id: Number(button.dataset.qr) }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message || "HTTP " + res.status);
      out.className = "ok";
      out.textContent = body.message;
    } catch (error) {
      out.className = "err";
      out.textContent = "No se pudo simular el depósito: " + error.message;
      button.disabled = false;
    }
  });
</script>
</body>
</html>
`;
}
