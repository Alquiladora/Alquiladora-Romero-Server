const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465, 
  secure: true, 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
    tls: {
    rejectUnauthorized: false, // ignora certificados no confiables en local
  },
});

 async  function sendEmail(to, subject, htmlContent) {
  try {
    const mailOptions = {
      from: `"Alquiladora Romero" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: htmlContent,
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


