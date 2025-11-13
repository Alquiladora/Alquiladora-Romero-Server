// email.js
const nodemailer = require("nodemailer");

const isProduction = process.env.NODE_ENV === "production";

let transporter;
let transporterReady = false;

// === INICIALIZAR TRANSPORTER ===
async function initTransporter() {
  if (transporterReady) return;

  if (isProduction) {
    // === PRODUCCIÓN: Hostinger ===
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      throw new Error("Faltan EMAIL_USER o EMAIL_PASSWORD en .env");
    }

    transporter = nodemailer.createTransport({
      host: "smtp.hostinger.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  } else {
    // === DESARROLLO: Ethereal ===
    console.log("Modo PRUEBA activado");
    const testAccount = await nodemailer.createTestAccount();
    console.log("Usuario Ethereal:", testAccount.user);
    console.log("Contraseña:", testAccount.pass);

    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  }

  transporterReady = true;
}

// === FUNCIÓN DE ENVÍO (con espera) ===
async function sendEmail(to, subject, htmlContent, textContent = null) {
  // Asegurarse de que transporter esté listo
  if (!transporterReady) {
    await initTransporter();
  }

  // Validaciones
  if (!to || !subject || !htmlContent) {
    return { success: false, message: "Faltan parámetros" };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to)) {
    return { success: false, message: "Email inválido" };
  }

  try {
    const plainText = textContent || htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    const mailOptions = {
      from: `"Alquiladora Romero" <${isProduction ? process.env.EMAIL_USER : 'pruebas@ethereal.email'}>`,
      to,
      subject,
      html: htmlContent,
      text: plainText.substring(0, 1000),
    };

    const info = await transporter.sendMail(mailOptions);

    if (!isProduction) {
      const url = nodemailer.getTestMessageUrl(info);
      console.log("EMAIL DE PRUEBA ENVIADO");
      console.log("ABRE ESTE ENLACE: ", url);
      return { success: true, url };
    }

    console.log("Email enviado en producción:", info.messageId);
    return { success: true, message: "Email enviado" };

  } catch (error) {
    console.error("Error al enviar email:", error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendEmail };