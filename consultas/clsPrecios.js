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
    pr.precioAdquirido,precioAlquiler,
    pr.diasAmortizacion,
    pr.costoOperativo,
    pr.margenPorcentaje
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


// Endpoint para agregar un precio (POST /api/precios/)
preciosRouter.post("/", csrfProtection, async (req, res) => {
    try {
      const {
        idProducto,
        precioAdquirido,
        diasAmortizacion,
        costoOperativo,
        margenPorcentaje
      } = req.body;
      
      console.log("Datos recibidos:", idProducto, precioAdquirido, diasAmortizacion, costoOperativo, margenPorcentaje);
        
     
      if (!idProducto) {
        return res.status(400).json({
          success: false,
          message: "El campo idProducto es requerido."
        });
      }
      if (!precioAdquirido || parseFloat(precioAdquirido) <= 0) {
        return res.status(400).json({
          success: false,
          message: "precioAdquirido debe ser un número mayor que 0."
        });
      }
    
   
      const [rowsCheck] = await pool.query(
        "SELECT COUNT(*) AS count FROM tblprecio WHERE idProducto = ?",
        [idProducto]
      );
      if (rowsCheck[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: "Este producto ya tiene un precio asignado."
        });
      }

      const currentDateTime = moment()
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss");

      const [result] = await pool.query(
        `
  CALL CrearPrecio(
      ?,  -- pIdProducto
      ?,  -- pPrecioAdquirido
      ?,  -- pDiasAmortizacion
      ?,  -- pCostoOperativo
      ?,  -- pMargenPorcentaje
      ?   -- pFechaCreacion
  )`,
        [
          idProducto,
          parseFloat(precioAdquirido),
          parseInt(diasAmortizacion) || 0,
          parseFloat(costoOperativo) || 0,
          parseFloat(margenPorcentaje) || 0,
          currentDateTime
        ]
      );
    
      // Construir el objeto nuevoPrecio (puedes ajustarlo según lo que retorne tu procedimiento)
      const nuevoPrecio = {
        id: result.insertId, // Suponiendo que el procedimiento retorna el insertId
        idProducto: parseInt(idProducto),
        precioAdquirido: parseFloat(precioAdquirido),
        diasAmortizacion: parseInt(diasAmortizacion) || 0,
        costoOperativo: parseFloat(costoOperativo) || 0,
        margenPorcentaje: parseFloat(margenPorcentaje) || 0,
        fechaCreacion: currentDateTime
      };
    
      console.log("Nuevo precio creado:", nuevoPrecio);
    
      return res.status(201).json({
        success: true,
        message: "Precio creado correctamente.",
        nuevoPrecio
      });
    } catch (error) {
      console.error("Error al crear precio:", error);
      return res.status(500).json({
        success: false,
        message: "Error interno del servidor."
      });
    }
  });


// Endpoint para actualizar precio
preciosRouter.put("/:id", csrfProtection, async (req, res) => {
    try {
        const { id } = req.params;
        const {
          idProducto,
          precioAdquirido,
          diasAmortizacion,
          costoOperativo,
          margenPorcentaje,
        } = req.body;
        console.log("Datis recubidos a actualizar",   idProducto,
            precioAdquirido,
            diasAmortizacion,
            costoOperativo,
            margenPorcentaje)

        if (
            !idProducto ||
            precioAdquirido === undefined ||
            diasAmortizacion === undefined ||
            costoOperativo === undefined ||
            margenPorcentaje === undefined
          ) {
            return res.status(400).json({
              success: false,
              message: "Todos los campos son requeridos.",
            });
          }
  
      const numPrecio = parseFloat(precioAdquirido);
      const numDias = parseInt(diasAmortizacion);
      const numCosto = parseFloat(costoOperativo);
      const numMargen = parseFloat(margenPorcentaje);
  
      if (isNaN(numPrecio) || numPrecio <= 0 || numPrecio > 1e8) {
        return res.status(400).json({
          success: false,
          message:
            "Ingresa un precioAdquirido válido (mayor que 0 y menor a 100 millones).",
        });
      }
      if (isNaN(numDias) || numDias <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Ingresa un número válido para Días de Amortización (mayor que 0).",
        });
      }
      if (isNaN(numCosto) || numCosto < 0 || numCosto > 1e8) {
        return res.status(400).json({
          success: false,
          message:
            "Ingresa un Costo Operativo válido (0 o mayor, menor a 100 millones).",
        });
      }
      if (isNaN(numMargen) || numMargen < 1 || numMargen > 100) {
        return res.status(400).json({
          success: false,
          message: "Ingresa un Margen Porcentual válido (entre 1 y 100).",
        });
      }

      const currentDateTime = moment()
      .tz("America/Mexico_City")
      .format("YYYY-MM-DD HH:mm:ss");
  
      const [result] = await pool.query(
        `
       CALL ActualizarPrecio(?, ?, ?, ?, ?,?)`,
        [
          idProducto,
          numPrecio,
          numDias,
          numCosto,
          numMargen,
          currentDateTime,
          id,
        ]
      );
  
      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Precio no encontrado." });
      }
  
      res.status(200).json({
        success: true,
        message: "Precio actualizado correctamente.",
      });
    } catch (error) {
      console.error("Error al actualizar precio:", error);
      res
        .status(500)
        .json({ success: false, message: "Error interno del servidor." });
    }
  });
  
  
preciosRouter.delete(
  "/delete/:id",
  csrfProtection,
  async (req, res) => {
    try {
      const { id } = req.params;
      console.log("PRECIO ELIMINAR ID", id)

      const [result] = await pool.query(
        `DELETE FROM tblprecio WHERE idProducto = ?;`,
        [id]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "No existe un precio con ese idProducto",
        });
      }
      
      res.status(200).json({
        success: true,
        message: "Precio eliminado correctamente",
      });
    } catch (error) {
      console.error("Error al eliminar producto:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  }
);




module.exports=preciosRouter;