// email.mjs — send one message through Gmail SMTP with an App Password.
//
// Environment (local .env or GitHub Actions secrets):
//   GMAIL_USER          the Gmail address that sends the alert
//   GMAIL_APP_PASSWORD  16-character App Password (not your normal password)
//   ALERT_TO            where alerts go; defaults to GMAIL_USER
import nodemailer from 'nodemailer';

export function emailSettings(env = process.env) {
  const user = env.GMAIL_USER?.trim();
  const pass = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  const to = (env.ALERT_TO || user || '').trim();
  const missing = [!user && 'GMAIL_USER', !pass && 'GMAIL_APP_PASSWORD'].filter(Boolean);
  return { user, pass, to, ok: missing.length === 0, missing };
}

/**
 * @param {{subject: string, html: string, text: string}} message
 * @param {object} [opts]  { env, transport } — transport is injectable for tests
 * @returns {Promise<{sent: boolean, id?: string, skipped?: string}>}
 */
export async function sendEmail(message, { env = process.env, transport } = {}) {
  const s = emailSettings(env);
  if (!s.ok) return { sent: false, skipped: `email not configured (missing ${s.missing.join(', ')})` };
  const t = transport || nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });
  const info = await t.sendMail({ from: `job-radar <${s.user}>`, to: s.to, ...message });
  return { sent: true, id: info.messageId };
}
