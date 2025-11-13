const nodemailer = require("nodemailer");

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
  throw new Error("Faltan EMAIL_USER o EMAIL_PASSWORD en las variables de entorno");
}

const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true, 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  connectionTimeout: 10000,
});

 async function sendEmail(to, subject, htmlContent, textContent = null) {
 
  if (!to || !subject || !htmlContent) {
    return { success: false, message: "Faltan parámetros: to, subject o htmlContent" };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to)) {
    return { success: false, message: "Dirección de email inválida" };
  }

  try {
    const plainText = textContent || htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const mailOptions = {
      from: `"Alquiladora Romero" <${process.env.EMAIL_USER}>`,
      to,
      html: htmlContent,
      text: plainText.substring(0, 1000),
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Correo enviado: ", info.messageId);
    return { success: true, message: "Email enviado con éxito" };
  } catch (error) {
    console.error("Error al enviar el email:", error);
    return { success: false, message: "Error al enviar el email", error: error.message };
  }
}

module.exports = { sendEmail };


