const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const emailRouter = express.Router();
emailRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const { Console } = require("console");

// Cola de correos
const emailQueue = new Queue("emailQueue");

const validateEmailFormat = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const domainCache = new Map();
const checkDomainMX = async (domain) => {
  if (domainCache.has(domain)) return domainCache.get(domain);
  try {
    const addresses = await dns.resolveMx(domain);
    const isValid = addresses && addresses.length > 0;
    domainCache.set(domain, isValid);
    return isValid;
  } catch (error) {
    return false;
  }
};

// Endpoint para validar un correo electrónico
emailRouter.post("/validate-email", csrfProtection, async (req, res) => {
  const { email } = req.body;
  console.log(email);
  if (!validateEmailFormat(email))
    return res
      .status(400)
      .json({ isValid: false, message: "Formato de correo no válido" });
  const hasMXRecords = await checkDomainMX(email.split("@")[1]);
  res.json({
    isValid: hasMXRecords,
    message: hasMXRecords ? "Correo válido" : "Dominio sin registros MX",
  });
});

// Validar reCAPTCHA v3

async function verifyRecaptcha(captchaToken) {
  console.log("tetokenrecap", captchaToken);
  try {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      null,
      {
        params: {
          secret: process.env.RECAPTCHA_SECRET_KEY,
          response: captchaToken,
        },
      }
    );
    console.log("response Verfica Recapchat", response.data);
    return response.data.success;
  } catch (error) {
    return false;
  }
}

//Funcion par avalidar Token
function generarToken() {
  const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }
  return token;
}


//Funcion para crearFechaToken
function getTokenCreationTime() {
  return new Date().toISOString();
}

function getTokenExpirationTime(creationTimeISO, expirationInMinutes) {
  const creationTime = new Date(creationTimeISO);
  if (isNaN(creationTime.getTime())) {
    throw new Error(`Fecha de creación inválida: ${creationTimeISO}`);
  }
  const expirationTime = new Date(
    creationTime.getTime() + expirationInMinutes * 60 * 1000
  );
  return expirationTime.toISOString();
}

// Enviar token al correo


emailRouter.post("/send", csrfProtection, async (req, res) => {
  const { correo, captchaToken, mensaje, nombreR } = req.body;

  console.log(correo, captchaToken, mensaje, nombreR);
  const shortUUID = generarToken();

  // Verifica el CAPTCHA en el backend
  const captchaVerified = await verifyRecaptcha(captchaToken);
  if (!captchaVerified) {
    return res
      .status(400)
      .json({ message: "Captcha no válido, por favor intente de nuevo." });
  }

  // Creación del token
  const creacioToken = getTokenCreationTime();
  const caducidadToken = getTokenExpirationTime(creacioToken, 10);
  const destinatario = nombreR || "Cliente";

  console.log("Datos enviados al correo:", correo, shortUUID);

  // Verifica si ya existe un token para este correo
  const checkQuery = "SELECT * FROM tbltokens WHERE correo = ?";
  const [existingToken] = await pool.query(checkQuery, [correo]);

  console.log("Token existente:", existingToken);

  let query;
  let values;

  if (existingToken.length === 0) { 
    query = "INSERT INTO tbltokens (token, fechaCreacion, fechaExpiracion, correo, destinatario) VALUES (?, ?, ?, ?, ?)";
    values = [shortUUID, creacioToken, caducidadToken, correo, destinatario];
  } else {
    query = "UPDATE tbltokens SET token = ?, fechaCreacion = ?, fechaExpiracion = ? WHERE correo = ?";
    values = [shortUUID, creacioToken, caducidadToken, correo];
  }

  try {
    await pool.query(query, values);

   
    const emailData = {
      sender: { name: "Alquiladora Romero", email: "alquiladoraromero@isoftuthh.com" },
      to: [{ email: correo, name: destinatario }],
      subject: "Código de verificación - Alquiladora Romero",
      htmlContent: `
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px;">
          <div style="max-width: 600px; margin: auto; padding: 20px; border-radius: 8px; background-color: #fff; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);">
            <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #eee;">
              <h1 style="color: #007BFF; margin: 0;">Alquiladora Romero</h1>
              <p style="font-size: 14px; color: #666; margin: 5px 0;">Tu mejor aliado en renta de mobiliario</p>
            </div>

            <div style="padding: 20px;">
              <h2 style="color: #28A745; font-size: 24px; text-align: center;">Código de Verificación</h2>
              <p style="font-size: 16px; text-align: center; color: #555; margin-top: 10px;">Hola <strong>${destinatario}</strong>,</p>
              <p style="font-size: 16px; text-align: center; color: #555;">Gracias por confiar en nosotros. Para continuar con el proceso, ingresa el siguiente código en los próximos <strong style="color: #FF5722;">10 minutos</strong>:</p>

              <div style="margin: 20px auto; text-align: center;">
                <p style="font-size: 32px; font-weight: bold; color: #007BFF; border: 2px dashed #007BFF; padding: 10px; border-radius: 8px; display: inline-block;">${shortUUID}</p>
              </div>

              <p style="font-size: 14px; text-align: center; color: #888;">Si el código no se utiliza dentro del tiempo establecido, deberás solicitar uno nuevo.</p>
            </div>

            <div style="margin-top: 20px; padding: 15px; background-color: #f1f1f1; border-radius: 8px; text-align: center;">
              <p style="font-size: 14px; color: #555;">¿Tienes dudas? Contáctanos en:</p>
              <p style="font-size: 14px; color: #555; margin: 5px 0;"><a href="mailto:alquiladoraromero@isoftuthh.com" style="color: #007BFF; text-decoration: none;">alquiladoraromero@isoftuthh.com</a></p>
            </div>

            <div style="text-align: center; margin-top: 20px;">
              <p style="font-size: 14px; color: #555;">Síguenos en nuestras redes sociales:</p>
              <div style="display: inline-flex; justify-content: center; gap: 15px; margin-top: 10px;">
                <a href="https://www.facebook.com/ALQROMERO" target="_blank" style="text-decoration: none;">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/5/51/Facebook_f_logo_%282019%29.svg" alt="Facebook" style="width: 30px; height: 30px;" />
                </a>
                <a href="https://www.facebook.com/ALQROMERO" target="_blank" style="text-decoration: none;">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Instagram_icon.png" alt="Instagram" style="width: 30px; height: 30px;" />
                </a>
              </div>
            </div>

            <div style="border-top: 1px solid #eee; padding-top: 15px; margin-top: 20px; text-align: center; font-size: 12px; color: #777;">
              <p>Este es un mensaje generado automáticamente. Por favor, no respondas a este correo.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    // Enviar el correo de verificación
    const response = await axios.post("https://api.brevo.com/v3/smtp/email", emailData, {
      headers: {
        accept: "application/json",
        "api-key": process.env.API_KEY,
        "content-type": "application/json",
      },
    });

    res.status(200).json({ message: "Email enviado con éxito" });
  } catch (error) {
    console.error("Error al enviar el email:", error);
    res.status(500).json({ message: "Error al enviar el email", error: error.message });
  }
});


module.exports = emailRouter;
