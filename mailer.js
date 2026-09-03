/**
 * Donut Overlays — outgoing email
 * ---------------------------------------------------------------
 * Thin wrapper over Resend's HTTP API. No SDK: it is one POST, and a
 * dependency that only makes one request is a dependency that can break
 * a deploy for no reason.
 *
 * If RESEND_API_KEY is not set, nothing is sent and the message is logged
 * instead. That is deliberate — the site has to keep working before the
 * email account exists, and a password reset that throws a 500 because a
 * key is missing is worse than one that quietly does not arrive.
 */
const { RESEND_API_KEY, MAIL_FROM, PUBLIC_URL = 'http://localhost:8080' } = process.env;

const FROM = MAIL_FROM || 'Donut Overlays <onboarding@resend.dev>';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* One house style for every email, so they are recognisable and so the
   text-only fallback is always generated from the same content. */
function wrap({ heading, lines, button }) {
  const body = lines.map(l => `<p style="margin:0 0 1em">${l}</p>`).join('');
  const cta = button
    ? `<p style="margin:1.6em 0">
         <a href="${esc(button.href)}"
            style="background:#2ee66b;color:#06210f;text-decoration:none;font-weight:700;
                   padding:.8em 1.4em;border-radius:.5em;display:inline-block">
           ${esc(button.label)}
         </a>
       </p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f6fa;padding:24px">
    <div style="max-width:34em;margin:0 auto;background:#fff;border-radius:12px;
                padding:32px;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a2233">
      <div style="font-weight:800;font-size:1.05em;color:#0e7a3c;margin-bottom:1.2em">Donut Overlays</div>
      <h1 style="font-size:1.35em;margin:0 0 .7em">${esc(heading)}</h1>
      ${body}
      ${cta}
      <hr style="border:0;border-top:1px solid #e3e8f0;margin:2em 0">
      <p style="color:#7a879c;font-size:.85em;margin:0">
        ${esc(PUBLIC_URL.replace(/^https?:\/\//, ''))}
      </p>
    </div></body></html>`;
}

function plain({ heading, lines, button }) {
  const strip = s => String(s).replace(/<[^>]+>/g, '');
  return [heading, '', ...lines.map(strip), button ? `\n${button.label}: ${button.href}` : '']
    .join('\n').trim();
}

async function send(to, subject, content) {
  const html = wrap(content);
  const text = plain(content);

  if (!RESEND_API_KEY) {
    console.log(`[mail] not configured — would have sent "${subject}" to ${to}`);
    return { sent: false, reason: 'no RESEND_API_KEY' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[mail] ${subject} -> ${to} failed: ${res.status} ${detail.slice(0, 300)}`);
      return { sent: false, reason: `resend ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[mail] ${subject} -> ${to} threw:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/* ---------------- the three emails the site actually sends ---------------- */

const welcome = (to) => send(to, 'Welcome to Donut Overlays', {
  heading: 'Your account is ready',
  lines: [
    'Thanks for signing up. Pick a plan on the site to start your 7 day free trial — no charge until it ends, and you can cancel from your account at any time.',
    'Once the trial starts you get a permanent overlay link to paste into TikTok LIVE Studio, OBS or Streamlabs, plus the launcher that runs the games on your PC.',
  ],
  button: { label: 'Open Donut Overlays', href: PUBLIC_URL },
});

const trialEnding = (to, endsAt, plan) => send(to, 'Your Donut Overlays trial ends in 3 days', {
  heading: 'Your free trial ends in 3 days',
  lines: [
    `Your ${plan === 'all' ? 'all three overlays' : 'single overlay'} trial ends on <strong>${esc(endsAt)}</strong>. After that the card on file is charged and your overlays keep working exactly as they are — nothing to re-add in OBS.`,
    'If it is not for you, cancel before that date from Manage plan on the site and you will not be charged a penny.',
  ],
  button: { label: 'Manage my plan', href: PUBLIC_URL },
});

const passwordReset = (to, link) => send(to, 'Reset your Donut Overlays password', {
  heading: 'Set a new password',
  lines: [
    'Use the button below to choose a new password. The link works once and expires in one hour.',
    'If you did not ask for this, you can ignore this email — your password has not changed.',
  ],
  button: { label: 'Set a new password', href: link },
});

module.exports = { send, welcome, trialEnding, passwordReset, configured: !!RESEND_API_KEY };
