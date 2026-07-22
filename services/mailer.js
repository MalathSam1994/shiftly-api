// services/mailer.js
const nodemailer = require('nodemailer');



const MAIL_LOGO_CID = 'shiftmix-logo';

function getMailLogoPath() {
  return (
    process.env.MAIL_LOGO_PATH ||
    '/opt/shiftly-api/img/idea2 transperant.png'
  );
}

function getMailLogoAttachment() {
  return {
    filename: 'shiftmix-logo.png',
    path: getMailLogoPath(),
    cid: MAIL_LOGO_CID,
    contentDisposition: 'inline',
  };
}

function buildHtmlSignature(appName) {
  return (
    `<p style="margin-top:24px; margin-bottom:8px;">Regards,</p>` +
    `<p style="margin-top:0; margin-bottom:10px;">` +
    `${escapeHtml(appName)}` +
    `</p>` +
    `<img ` +
    `src="cid:${MAIL_LOGO_CID}" ` +
    `alt="${escapeHtml(appName)}" ` +
    `width="160" ` +
    `style="display:block; width:160px; max-width:100%; height:auto; border:0;"` +
    `/>`
  );
}

function assertEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function buildTransport() {
  const host = assertEnv('SMTP_HOST'); // e.g. smtp-relay.brevo.com
  const port = Number(assertEnv('SMTP_PORT')); // 587 (STARTTLS) or 465 (TLS)
  const user = assertEnv('SMTP_USER');
  const pass = assertEnv('SMTP_PASS');

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for 587
    auth: { user, pass },
  });
}

// Generic low-level sender (useful for tests and one-off emails)
async function sendMail({
  to,
  subject,
  text,
  html,
  from,
  attachments = [],
}) {
  const transporter = buildTransport();
  const finalFrom = from || assertEnv('SMTP_FROM');

  return transporter.sendMail({
    from: finalFrom,
    to,
    subject,
    text,
    html,
    attachments,
  });
}


async function sendUserWelcomeEmail({ to, username, tempPassword }) {
  const from = assertEnv('SMTP_FROM'); // e.g. "Shiftly <no-reply@yourdomain>"
  const appName = process.env.APP_NAME || 'Shiftly';

  const transporter = buildTransport();

  const subject = `${appName} - Your account credentials`;
  const text =
    `Hello,\n\n` +
    `An account was created for you in ${appName}.\n\n` +
    `Username: ${username}\n` +
    `Temporary password: ${tempPassword}\n\n` +
    `For security reasons, you will be required to change your password on first login.\n\n` +
    `Regards,\n${appName}\n`;

  const html =
    `<p>Hello,</p>` +
    `<p>An account was created for you in <b>${appName}</b>.</p>` +
    `<p><b>Username:</b> ${escapeHtml(username)}<br/>` +
    `<b>Temporary password:</b> ${escapeHtml(tempPassword)}</p>` +
    `<p><b>For security reasons, you will be required to change your password on first login.</b></p>` +
    buildHtmlSignature(appName);

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
    attachments: [getMailLogoAttachment()],
  });
}

async function sendResetPasswordEmail({ to, username, tempPassword }) {
  const from = assertEnv('SMTP_FROM');
  const appName = process.env.APP_NAME || 'Shiftly';

  const transporter = buildTransport();

  const subject = `${appName} - Password reset`;
  const text =
    `Hello,\n\n` +
    `A password reset was requested for your ${appName} account.\n\n` +
    `Username: ${username}\n` +
    `Temporary password: ${tempPassword}\n\n` +
    `You will be required to change your password immediately after login.\n\n` +
    `Regards,\n${appName}\n`;

  const html =
    `<p>Hello,</p>` +
    `<p>A password reset was requested for your <b>${appName}</b> account.</p>` +
    `<p><b>Username:</b> ${escapeHtml(username)}<br/>` +
    `<b>Temporary password:</b> ${escapeHtml(tempPassword)}</p>` +
   `<p><b>You will be required to change your password immediately after login.</b></p>` +
   buildHtmlSignature(appName);

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
    attachments: [getMailLogoAttachment()],
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

module.exports = {
    sendMail,
  sendUserWelcomeEmail,
  sendResetPasswordEmail,
};
