const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const preciosRouter = express.Router();
preciosRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const { Console } = require("console");
const moment = require("moment");


preciosRouter.get("/precios", async (req, res) => {
  try {
    const [rows] = await pool.query(`
  
SELECT
        p.idProducto,
        p.nombre AS nombreProducto,
        p.idSubcategoria,
        s.nombre AS nombreSubcategoria,
        s.idCategoria,
        c.nombre AS nombreCategoria,
        pr.idPrecio,
        pr.precioAlquiler
      FROM tblproductos p
      JOIN tblsubcategoria s ON p.idSubcategoria = s.idSubCategoria
      JOIN tblcategoria c ON s.idCategoria = c.idCategoria
      LEFT JOIN tblprecio pr ON p.idProducto = pr.idProducto;
      `);

    res.status(200).json({ success: true, precios: rows });
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});



preciosRouter.post("/", csrfProtection, async (req, res) => {
    try {
      const { idProducto, precioAlquiler } = req.body;
      if (!idProducto) {
        return res.status(400).json({
          success: false,
          message: "El campo idProducto es requerido.",
        });
      }
      if (!precioAlquiler || parseFloat(precioAlquiler) <= 0) {
        return res.status(400).json({
          success: false,
          message: "precioAlquiler debe ser un número mayor que 0.",
        });
      }
   
      const [rowsCheck] = await pool.query(
        "SELECT COUNT(*) AS count FROM tblprecio WHERE idProducto = ?",
        [idProducto]
      );
      if (rowsCheck[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: "Este producto ya tiene un precio asignado.",
        });
      }
  
      const currentDateTime = moment()
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss");
  
      const [result] = await pool.query(
        `
        INSERT INTO tblprecio (idProducto, precioAlquiler, fechaCreacion)
        VALUES (?, ?, ?)
        `,
        [idProducto, parseFloat(precioAlquiler), currentDateTime]
      );
    
      
      const nuevoPrecio = {
        idPrecio: result.insertId, 
        idProducto: parseInt(idProducto),
        precioAlquiler: parseFloat(precioAlquiler),
        fechaCreacion: currentDateTime,
      };
    
      return res.status(201).json({
        success: true,
        message: "Precio creado correctamente.",
        nuevoPrecio,
      });
    } catch (error) {
      console.error("Error al crear precio:", error);
      return res.status(500).json({
        success: false,
        message: "Error interno del servidor.",
      });
    }
  });



preciosRouter.put("/:id", csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    const { idProducto, precioAlquiler } = req.body;

    if (!idProducto) {
      return res.status(400).json({
        success: false,
        message: "El campo idProducto es requerido.",
      });
    }
    if (!precioAlquiler || parseFloat(precioAlquiler) <= 0) {
      return res.status(400).json({
        success: false,
        message: "precioAlquiler debe ser un número mayor que 0.",
      });
    }

    const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");

    const [result] = await pool.query(
      `
      UPDATE tblprecio
      SET idProducto = ?, precioAlquiler = ?, fechaCreacion = ?
      WHERE idPrecio = ?
      `,
      [idProducto, parseFloat(precioAlquiler),  currentDateTime, id]
    );

  if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Precio no encontrado.",
      });
    }

    const [updatedPrice] = await pool.query(
      `
      SELECT idPrecio, idProducto, precioAlquiler, fechaCreacion
      FROM tblprecio
      WHERE idPrecio = ?
      `,
      [id]
    );
  
    res.status(200).json({
      success: true,
      message: "Precio actualizado correctamente.",
      updatedPrice: updatedPrice[0],
    });
  } catch (error) {
    console.error("Error al actualizar precio:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
    });
  }
});

  
  
preciosRouter.delete("/delete/:id", csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;


    const [result] = await pool.query(
      `DELETE FROM tblprecio WHERE idPrecio = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "No existe un precio con ese idPrecio",
      });
    }

    res.status(200).json({
      success: true,
      message: "Precio eliminado correctamente",
    });
  } catch (error) {
    console.error("Error al eliminar precio:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});



module.exports=preciosRouter;