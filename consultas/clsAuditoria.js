const express = require("express");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const crypto = require("crypto");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");




const auditoriaRouter = express.Router();
auditoriaRouter.use(express.json());
auditoriaRouter.use(cookieParser());


//Insertamos la auditoria
auditoriaRouter.post("/auditoria",csrfProtection, async (req, res) => {
    const { usuario, correo, accion, dispositivo, ip, fecha_hora, detalles } =
      req.body;
  
    try {
      const query = `
        INSERT INTO tblauditoria (usuario, correo, accion, dispositivo, ip, fecha_hora, detalles)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      await pool.query(query, [
        usuario,
        correo,
        accion,
        dispositivo,
        ip,
        fecha_hora,
        detalles,
      ]);
      console.log("Auditoria registrado hoy correcatmemte")
      res
        .status(200)
        .json({ message: "Registro de auditoría almacenado correctamentex" });
    } catch (error) {
      console.error("Error al guardar el registro de auditoría:", error);
      res
        .status(500)
        .json({ message: "Error al guardar el registro de auditoría" });
    }
  });

  //Consulta de auditoria
  auditoriaRouter.get("/auditoria/lista", async (req, res) => {
    try {
      const query = `
        SELECT 
          idAuditoria, 
          usuario, 
          correo, 
          accion, 
          dispositivo, 
          ip, 
          fecha_hora, 
          detalles 
        FROM tblauditoria
        ORDER BY fecha_hora DESC
      `;
  
      const [auditorias] = await req.db.query(query);
  
      res.status(200).json(auditorias);
      console.log("Auditoria registrado hoy correcatmemte")
    } catch (error) {
      console.error("Error al obtener los registros de auditoría:", error);
      res
        .status(500)
        .json({ message: "Error al obtener los registros de auditoría" });
    }
  });


  module.exports= auditoriaRouter;