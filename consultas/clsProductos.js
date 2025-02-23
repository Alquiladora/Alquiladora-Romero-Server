const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const { pool } = require("../connectBd");
const produtosRouter = express.Router();
produtosRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const Queue = require("bull");
const now = new Date();
const crypto = require("crypto");
const { Console } = require("console");
const moment = require("moment");

produtosRouter.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.query(`
        SELECT
          p.idProducto,
          p.nombre,
          p.detalles,
          p.foto,
          p.color,
          p.material,
          p.fechaCreacion,
          p.fechaActualizacion,
          sc.nombre AS subcategoria,
          c.nombre AS categoria,
          u.nombre AS nombreUsuario,
          u.correo AS emailUsuario
        FROM tblproductos p
        INNER JOIN tblsubcategoria sc ON p.idSubcategoria = sc.idSubcategoria
        INNER JOIN tblcategoria c ON sc.idcategoria = c.idcategoria
        INNER JOIN tblusuarios u ON p.idUsuarios = u.idUsuarios
        ORDER BY p.fechaCreacion DESC
      `);

    res.status(200).json({ success: true, products: rows });
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor",
    });
  }
});

produtosRouter.get("/bodegas", async (req, res) => {
    try {
      const [rows] = await pool.query(`
         SELECT *FROM tblbodegas;
        `);
  
      res.status(200).json({ success: true, bodegas: rows });
    } catch (error) {
      console.error("Error al obtener las bodegas", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  });

produtosRouter.get("/subcategorias", async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          c.idCategoria,
          c.nombre AS categoryName,
          sc.idSubcategoria,
          sc.nombre AS subcatName
        FROM tblcategoria c
        JOIN tblsubcategoria sc ON c.idCategoria = sc.idCategoria
        ORDER BY c.nombre, sc.nombre
      `);
  
    
      const categoryMap = {};
      rows.forEach((row) => {
        const { idCategoria, categoryName, idSubcategoria, subcatName } = row;
  
       
        if (!categoryMap[idCategoria]) {
          categoryMap[idCategoria] = {
            categoryName,
            subcats: []
          };
        }
  
       
        categoryMap[idCategoria].subcats.push({
          id: idSubcategoria,
          label: subcatName
        });
      });
  
      
      const grouped = Object.values(categoryMap);
  
      res.status(200).json({
        success: true,
        subcategories: grouped
      });
    } catch (error) {
      console.error("Error al obtener subcategorias:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor",
      });
    }
  });


  produtosRouter.post("/products",csrfProtection, async (req, res) => {
    try {
      const {
        nombre,
        detalles,
        idSubcategoria,
        foto,
        color,
        material,
        idUsuarios,
        idBodega
      } = req.body;
  
     
      if (
        !nombre ||
        !detalles ||
        !idSubcategoria ||
        !foto ||
        !color ||
        !material ||
        !idUsuarios ||
        !idBodega
      ) {
        return res.status(400).json({
          success: false,
          message: "Todos los campos son requeridos."
        });
      }
  
    
      const currentDateTime = moment()
        .tz("America/Mexico_City")
        .format("YYYY-MM-DD HH:mm:ss");
  
    
      const [result] = await pool.query(
        `CALL InsertarProducto(?, ?, ?, ?, ?, ?, ?, ?,?,?);`,
        [
          nombre,
          detalles,
          idSubcategoria,
          foto,
          color,
          material,
          currentDateTime,
          currentDateTime, 
          idUsuarios,
          idBodega
        ]
      );
  
   
      res.status(201).json({
        success: true,
        message: "Producto insertado correctamente",
        idProducto: result.insertId
      });
    } catch (error) {
      console.error("Error al insertar producto:", error);
      res.status(500).json({
        success: false,
        message: "Error interno del servidor"
      });
    }
  });
  

module.exports = produtosRouter;
