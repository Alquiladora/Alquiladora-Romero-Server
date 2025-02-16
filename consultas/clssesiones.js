const express = require("express");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const crypto = require("crypto");
const { csrfProtection } = require("../config/csrf");
const moment = require("moment");
const otplib = require("otplib");
const qrcode = require("qrcode");


const { pool } = require("../connectBd");
const sesionesRouter = express.Router();
sesionesRouter.use(express.json());
sesionesRouter.use(cookieParser());



sesionesRouter.post("/sesiones", csrfProtection, async (req, res) => {
    const { userId } = req.body;
    console.log("Id de sesiones enviado ", userId)
  
    if (!userId) {
      return res.status(400).json({ message: "El userId es necesario." });
    }
  
    try {
      if (!pool) {
        return res.status(500).json({ message: "Error de conexión con la base de datos." });
      }
  
      // Obtener todas las sesiones activas del sesiones
      const [sessions] = await pool.query(
        `
        SELECT 
          idSesion AS id,
          idsesioness,
          direccionIP,
          horaInicio,
          horaFin,
          tokenSesion,
          tipoDispositivo,
          cookie
        FROM tblsesiones
        WHERE idsesioness = ? AND horaFin IS NULL
      `,
        [userId]
      );
  
      if (!sessions || sessions.length === 0) {
        return res.json([]);
      }
      const currentToken = req.cookies.sesionToken;
  
      console.log("Este es el tokn 123", currentToken)
  
  
      const sessionsWithCurrentFlag = sessions.map((session) => ({
        ...session,
        isCurrent: session.tokenSesion === currentToken,
      }));
  
      console.log("sesion de token obtenido ",  sessionsWithCurrentFlag)
  
  
  
  
      res.json(sessionsWithCurrentFlag);
    } catch (error) {
      console.error("Error al obtener las sesiones del sesiones:", error);
      res
        .status(500)
        .json({ message: "Error al obtener las sesiones del sesiones." });
    }
  });
  
  
  sesionesRouter.post("/cerrar-todas-sesiones", async (req, res) => {
    const { userId, deviceTime } = req.body;
    const currentToken = req.cookies.sesionToken;
  
    if (!userId || !deviceTime) {
      return res
        .status(400)
        .json({ message: "userId y hora del dispositivo son requeridos." });
    }
  
    if (!currentToken) {
      return res
        .status(400)
        .json({ message: "Token de sesión no encontrado en las cookies." });
    }
  
    try {
      const query = `
        UPDATE tblsesiones
        SET horaFin = ?
        WHERE idsesiones = ? AND horaFin IS NULL AND tokenSesion != ?
      `;
      const [result] = await req.db.query(query, [
        deviceTime,
        userId,
        currentToken,
      ]);
  
      res.json({
        message: "Todas las sesiones excepto la actual han sido cerradas.",
        closedSessions: result.affectedRows,
      });
    } catch (error) {
      console.error("Error al cerrar todas las sesiones:", error);
      res.status(500).json({ message: "Error al cerrar todas las sesiones." });
    }
  });

  // Endpoint para registrar la expiración de sesión
sesionesRouter.post("/session-expired", async (req, res) => {
    const { userId } = req.body;
    const ip = getClientIp(req);
  
    if (!userId) {
      return res.status(400).json({ message: "ID de sesiones no proporcionado." });
    }
  
    try {
      const [sessions] = await req.db.query(
        `SELECT * FROM tblsesiones WHERE idsesiones = ? AND horaFin IS NULL ORDER BY horaInicio DESC LIMIT 1`,
        [userId]
      );
  
      if (sessions.length === 0) {
        return res.status(404).json({
          message: "No se encontró una sesión activa para este sesiones.",
        });
      }
  
      const session = sessions[0];
  
      if (session.direccionIP !== ip) {
        return res
          .status(403)
          .json({ message: "No autorizado para cerrar esta sesión." });
      }
  
      const query = `
        UPDATE tblsesiones
        SET horaFin = NOW()
        WHERE id = ?
      `;
      await req.db.query(query, [session.id]);
  
      res.json({ message: "Sesión expirada registrada correctamente." });
    } catch (error) {
      console.error("Error al registrar la expiración de sesión:", error);
      res
        .status(500)
        .json({ message: "Error al registrar la expiración de sesión." });
    }
  });


  

  module.exports= sesionesRouter;