const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const coloresRouter = express.Router();
coloresRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const moment = require("moment");


const validateColorInput = (color, codigoH) => {
  const errors = [];

  if (!color || typeof color !== "string" || color.trim().length === 0) {
    errors.push("El campo 'color' es obligatorio y debe ser una cadena no vacía.");
  } else if (color.length > 100) {
    errors.push("El campo 'color' no puede exceder los 100 caracteres.");
  }
  if (codigoH) {
    if (typeof codigoH !== "string" || codigoH.length > 100) {
      errors.push("El campo 'codigoH' no puede exceder los 100 caracteres.");
    } else if (!/^#[0-9A-Fa-f]{6}$/.test(codigoH)) {
      errors.push("El campo 'codigoH' debe ser un código hexadecimal válido (ej. #FF0000).");
    }
  }

  return errors;
};


coloresRouter.get("/colores", async (req, res) => {
  try {
    const { id } = req.query; 
    let query;
    let values;

    if (id) {

      query = "SELECT * FROM tblcolores WHERE idColores = ?";
      values = [id];
    } else {
  
      query = "SELECT * FROM tblcolores";
      values = [];
    }

    const [rows] = await pool.query(query, values);

    if (id && rows.length === 0) {
      return res.status(404).json({ success: false, message: "Color no encontrado." });
    }

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error(`[${moment().format("YYYY-MM-DD HH:mm:ss")}] Error al obtener colores:`, error);
    res.status(500).json({ success: false, message: "Error al obtener los colores.", error: error.message });
  }
});


const capitalizeFirstLetter = (str) => {
    if (!str || typeof str !== "string") return str;
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  };

coloresRouter.post("/colores", csrfProtection, async (req, res) => {
    let { color, codigoH } = req.body;
  
    // Capitalize the first letter of the color
    color = capitalizeFirstLetter(color);
  
    // Validate input with the capitalized color
    const errors = validateColorInput(color, codigoH);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: "Errores de validación.", errors });
    }
  
    try {
      const query = "INSERT INTO tblcolores (color, codigoH) VALUES (?, ?)";
      const values = [color.trim(), codigoH ? codigoH.trim() : null];
  
      const [result] = await pool.query(query, values);
  
      res.status(201).json({
        success: true,
        message: "Color agregado exitosamente.",
        data: { idColores: result.insertId, color, codigoH },
      });
    } catch (error) {
      console.error(`[${moment().format("YYYY-MM-DD HH:mm:ss")}] Error al agregar color:`, error);
      res.status(500).json({ success: false, message: "Error al agregar el color.", error: error.message });
    }
  });
  
 
  coloresRouter.put("/colores/:id", csrfProtection, async (req, res) => {
    const { id } = req.params;
    let { color, codigoH } = req.body;
  
    color = capitalizeFirstLetter(color);
  
    const errors = validateColorInput(color, codigoH);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: "Errores de validación.", errors });
    }
  
    try {
   
      const [existing] = await pool.query("SELECT * FROM tblcolores WHERE idColores = ?", [id]);
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: "Color no encontrado." });
      }
  
      const query = "UPDATE tblcolores SET color = ?, codigoH = ? WHERE idColores = ?";
      const values = [color.trim(), codigoH ? codigoH.trim() : null, id];
  
      await pool.query(query, values);
  
      res.status(200).json({
        success: true,
        message: "Color actualizado exitosamente.",
        data: { idColores: parseInt(id), color, codigoH },
      });
    } catch (error) {
      console.error(`[${moment().format("YYYY-MM-DD HH:mm:ss")}] Error al actualizar color:`, error);
      res.status(500).json({ success: false, message: "Error al actualizar el color.", error: error.message });
    }
  });


coloresRouter.delete("/colores/:id", csrfProtection, async (req, res) => {
  const { id } = req.params;

  try {
   
    const [existing] = await pool.query("SELECT * FROM tblcolores WHERE idColores = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Color no encontrado." });
    }

     const [associations] = await pool.query(
      "SELECT idProductoColores FROM tblproductoscolores WHERE idColor = ?",
      [id]
    );

    if (associations.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Este color no se puede eliminar porque está asociado a uno o más productos."
      });
    }

    const query = "DELETE FROM tblcolores WHERE idColores = ?";
    await pool.query(query, [id]);

    res.status(200).json({ success: true, message: "Color eliminado exitosamente." });
  } catch (error) {
 
    res.status(500).json({ success: false, message: "Error al eliminar el color.", error: error.message });
  }
});

module.exports = coloresRouter;