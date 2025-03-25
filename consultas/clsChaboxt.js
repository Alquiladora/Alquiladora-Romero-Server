const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const routerChatBox = express.Router();

// Middlewares
routerChatBox.use(express.json());
routerChatBox.use(cookieParser());


// Inicializar Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Obtener información de la empresa directamente desde la base de datos
const fetchEmpresaInfo = async () => {
  try {
    const query = "SELECT nombre, nosotros, mision, vision, valores, servicios FROM empresa LIMIT 1";
    const [rows] = await pool.query(query);
    if (rows.length === 0) {
      throw new Error("No se encontraron datos de la empresa en la base de datos");
    }
    return rows[0];
  } catch (error) {
    console.error("Error al obtener información de la empresa:", error);
    return null;
  }
};

// Endpoint para manejar los mensajes
routerChatBox.post("/api/gemini", csrfProtection, async (req, res) => {
  const { message, history = [] } = req.body;

  // Validar el mensaje
  if (!message || message.trim() === "") {
    return res.status(400).json({ error: "El mensaje no puede estar vacío" });
  }

  try {
    let botResponseText = "";
    const lowerCaseInput = message.toLowerCase();
    const empresaInfo = await fetchEmpresaInfo();

    if (empresaInfo) {
      if (lowerCaseInput.includes("nombre") || lowerCaseInput.includes("como se llama")) {
        botResponseText = `El nombre de la empresa es: ${empresaInfo.nombre}.`;
      } else if (
        lowerCaseInput.includes("quienes son") ||
        lowerCaseInput.includes("acerca de") ||
        lowerCaseInput.includes("farmamedic")
      ) {
        botResponseText = `${empresaInfo.nosotros}.`;
      } else if (lowerCaseInput.includes("mision")) {
        botResponseText = `${empresaInfo.mision}.`;
      } else if (lowerCaseInput.includes("vision")) {
        botResponseText = `Visión: ${empresaInfo.vision}.`;
      } else if (lowerCaseInput.includes("valores")) {
        botResponseText = `Nuestros valores son: ${empresaInfo.valores}.`;
      } else if (lowerCaseInput.includes("servicios")) {
        botResponseText = `Ofrecemos los siguientes servicios: ${empresaInfo.servicios}.`;
      } else {
        // Usar Gemini API con contexto conversacional
        const chat = model.startChat({
          history: history.map((msg) => ({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.text }],
          })),
        });
        const result = await chat.sendMessage(message);
        botResponseText = result.response.text();
      }
    } else {
      botResponseText = "Lo siento, no pude obtener información sobre la empresa en este momento.";
    }

    res.json({ response: botResponseText });
  } catch (error) {
    console.error("Error al procesar el mensaje:", error);
    res.status(500).json({
      error: "Lo siento, ocurrió un error al procesar tu mensaje.",
      details: error.message,
    });
  }
});

module.exports = routerChatBox;