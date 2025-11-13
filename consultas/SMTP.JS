
const { Resend } = require('resend');


const resend = new Resend(process.env.RESEND_API_KEY);

const isProduction = process.env.NODE_ENV === "production";

async function sendEmail(to, subject, htmlContent, textContent = null) {

  if (!to || !subject || !htmlContent) {
    return { success: false, message: "Faltan parámetros" };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to)) {
    return { success: false, message: "Email inválido" };
  }

  try {
    const plainText = textContent || htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const fromEmail = isProduction 
  ? `"Alquiladora Romero" <noreply@send.alquiladoraromero.bina5.com>` 
  : `"Alquiladora Romero" <pruebas@alquiladoraromero.bina5.com>`;

    const data = await resend.emails.send({
      from: fromEmail,
      to: [to],
      subject,
      html: htmlContent,
      text: plainText.substring(0, 1000),
    });

    console.log("Email enviado con Resend:", data.id);

    // En desarrollo: simula Ethereal
    if (!isProduction) {
      console.log("MODO PRUEBA: Email simulado (llegará en producción)");
      return { success: true, url: "https://resend.com/emails" };
    }

    return { success: true, message: "Email enviado", id: data.id };

  } catch (error) {
    console.error("Error al enviar email:", error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendEmail };