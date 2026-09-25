const nodemailer = require("nodemailer");

const FROM = "hello@souvs.shop";

function configured() {
  return Boolean(process.env.TITAN_SMTP_PASSWORD);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function sendWelcome({ email, name, kind }) {
  if (!configured()) return false;
  const transport = nodemailer.createTransport({
    host: "smtp.titan.email",
    port: 465,
    secure: true,
    auth: { user: FROM, pass: process.env.TITAN_SMTP_PASSWORD },
  });
  const firstName = String(name).trim().split(/\s+/)[0] || "friend";
  const subject = kind === "profile" ? "Welcome to Souvs!" : "You're on the Souvs list!";
  const message = kind === "profile"
    ? "Your Souvs profile is ready. Come say hello and discover people and places in your city."
    : "Thanks for joining Souvs. We'll let you know when your city opens.";
  await transport.sendMail({
    from: `Souvs <${FROM}>`, to: email, subject,
    text: `Hi ${firstName},\n\n${message}\n\nSee you at https://souvs.shop/\n\nThe Souvs team`,
    html: `<p>Hi ${escapeHtml(firstName)},</p><p>${escapeHtml(message)}</p><p>See you at <a href="https://souvs.shop/">souvs.shop</a>!</p><p>The Souvs team</p>`,
  });
  return true;
}

module.exports = { sendWelcome };
