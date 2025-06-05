const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const bodegasRouter = express.Router();
bodegasRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const { Console } = require("console");
const moment = require("moment");
const { verifyToken } = require('./clsUsuarios');



bodegasRouter.get("/bodegas",verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(`
   
SELECT *FROM tblbodegas;
      `);

    res.status(200).json({ success: true, bodegas: rows });
  } catch (error) {
    console.error("Error al obtener bodegas:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
}); 


bodegasRouter.post("/bodegas/crear",csrfProtection,verifyToken, async (req, res) => {
  try {
    const { nombre, ubicacion } = req.body;

    // Validar campos requeridos
    if (!nombre || !ubicacion) {
      return res.status(400).json({
        success: false,
        message: "El nombre y la ubicación son obligatorios.",
      });
    }

    const [existeBodega] = await pool.query(
      "SELECT idBodega FROM tblbodegas WHERE nombre = ? AND ubicacion = ?",
      [nombre, ubicacion]
    );
    if (existeBodega.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Ya existe una bodega con ese nombre y ubicación.",
      });
    }
     const currentDateTime = moment()
            .tz("America/Mexico_City")
            .format("YYYY-MM-DD HH:mm:ss");
    await pool.query(
      `INSERT INTO tblbodegas (nombre, ubicacion, tipo, estado, fechaRegistro, es_principal)
       VALUES (?, ?, 'temporal', 'activa', ?, 0)`,
      [nombre, ubicacion, currentDateTime]
    );

    return res.status(201).json({
      success: true,
      message: "Bodega secundaria creada exitosamente.",
    });
  } catch (error) {
    console.error("Error al crear la bodega secundaria:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});



bodegasRouter.delete(
  "/delete/:id",
  csrfProtection,verifyToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      console.log("datos recibidos", id)

      const [result] = await pool.query(`DELETE FROM tblbodegas WHERE idBodega=?`, [id]);
      res.status(201).json({
        success: true,
        message: "Producto eliminado correcatamente",
        idProducto: result.insertId,
      });

      console.log("Producto eliminado correcatamente")
    } catch (error) {
      console.error("Error al eliminar producto:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  }
);



bodegasRouter.patch("/toggle/:id", csrfProtection,verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await pool.query(
      "SELECT estado FROM tblbodegas WHERE idBodega = ?",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Bodega no encontrada.",
      });
    }

    const currentEstado = rows[0].estado;
    const newEstado = currentEstado === "activa" ? "inactiva" : "activa";

    await pool.query(
      "UPDATE tblbodegas SET estado = ? WHERE idBodega = ?",
      [newEstado, id]
    );

    res.status(200).json({
      success: true,
      message: "Estado de la bodega actualizado correctamente.",
      estado: newEstado,
    });
  } catch (error) {
    console.error("Error al actualizar el estado de la bodega:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});



bodegasRouter.patch("/update/:id", csrfProtection,verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, ubicacion } = req.body;

  
    if (!nombre || !ubicacion) {
      return res.status(400).json({
        success: false,
        message: "El nombre y la ubicación son obligatorios.",
      });
    }

   
    const [rows] = await pool.query(
      "SELECT * FROM tblbodegas WHERE idBodega = ?",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Bodega no encontrada.",
      });
    }

    
    const [duplicados] = await pool.query(
      "SELECT idBodega FROM tblbodegas WHERE nombre = ? AND ubicacion = ? AND idBodega <> ?",
      [nombre, ubicacion, id]
    );
    if (duplicados.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Ya existe otra bodega con ese nombre y ubicación.",
      });
    }

   
    await pool.query(
      "UPDATE tblbodegas SET nombre = ?, ubicacion = ? WHERE idBodega = ?",
      [nombre, ubicacion, id]
    );

    return res.status(200).json({
      success: true,
      message: "Bodega actualizada correctamente.",
    });
  } catch (error) {
    console.error("Error al actualizar la bodega:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});


module.exports= bodegasRouter;


