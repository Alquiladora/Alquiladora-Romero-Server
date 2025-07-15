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
const { verifyToken } = require('./clsUsuarios');





const auditoriaRouter = express.Router();
auditoriaRouter.use(express.json());
auditoriaRouter.use(cookieParser());



auditoriaRouter.post("/auditoria",csrfProtection, async (req, res) => {
    const { usuario, correo, accion, dispositivo, ip, detalles } =
      req.body;
      const fecha_hora = new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" });
  
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

 
  auditoriaRouter.get("/auditoria/lista", async (req, res) => {
    try {
      
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;
  
      const { month, year } = req.query; 
  
    
      let whereClause = "";
      const params = [];
  
      if (year && !isNaN(year)) {
        whereClause += " WHERE YEAR(fecha_hora) = ? ";
        params.push(parseInt(year, 10));
  
        if (month && !isNaN(month)) {
          whereClause += " AND MONTH(fecha_hora) = ? ";
          params.push(parseInt(month, 10) + 1); 
        
        }
      }
  
      
      const query = `
        SELECT
          idAuditoria AS id,
          usuario,
          correo,
          accion,
          dispositivo,
          ip,
          fecha_hora,
          detalles
        FROM tblauditoria
        ${whereClause}
        ORDER BY fecha_hora DESC
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
  
      const [auditorias] = await pool.query(query, params);
  
     
      const countQuery = `
        SELECT COUNT(*) as total
        FROM tblauditoria
        ${whereClause}
      `;
  
    
      const countParams = params.slice(0, -2);
  
      const [countResult] = await pool.query(countQuery, countParams);
      const total = countResult[0].total;
  
    
      const totalPages = Math.ceil(total / limit);
  
      res.status(200).json({
        data: auditorias,
        total,
        totalPages,
        currentPage: page,
        limit,
      });
    } catch (error) {
      console.error("Error al obtener los registros de auditoría:", error);
      res
        .status(500)
        .json({ message: "Error al obtener los registros de auditoría" });
    }
  });
  

  module.exports= auditoriaRouter;