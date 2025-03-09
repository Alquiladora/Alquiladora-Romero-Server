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

const routerInventario = express.Router();
routerInventario.use(express.json());
routerInventario.use(cookieParser());


routerInventario.get("/", csrfProtection, async (req, res) => {
    const sql = `
   SELECT 
    p.idProducto,
    p.nombre,
    p.detalles,
    p.color,
    p.material,
    sub.idSubCategoria,
    sub.nombre AS nombreSubcategoria,
    categ.idcategoria,
    categ.nombre AS nombreCategoria,
    usua.idUsuarios,
    usua.correo,
    pre.idPrecio,
    pre.precioAlquiler,
    bod.idBodega,
    bod.nombre AS nombreBodega,
    bod.es_principal,
    bod.ubicacion,
    inv.idInventario,
    inv.stockReal,
    inv.stock,
    inv.stockReservado,
    inv.estado,
    inv.notas,
    inv.fechaRegistro,
    (
      SELECT fp.urlFoto 
      FROM tblfotosproductos fp
      WHERE fp.idProducto = p.idProducto
      LIMIT 1
    ) AS urlFoto
FROM tblinventario inv
    LEFT JOIN tblproductos p 
        ON inv.idProducto = p.idProducto
    LEFT JOIN tblsubcategoria sub 
        ON p.idSubcategoria = sub.idSubCategoria
    LEFT JOIN tblcategoria categ
        ON sub.idCategoria = categ.idcategoria
    LEFT JOIN tblusuarios usua
        ON p.idUsuarios = usua.idUsuarios
    LEFT JOIN tblprecio pre
        ON p.idProducto = pre.idProducto
    LEFT JOIN tblbodegas bod
        ON inv.idBodega = bod.idBodega;

    `;
    
    try {
      const [rows] = await pool.query(sql);
      res.json(rows);
    } catch (error) {
      winston.error("Error al obtener inventario: ", error);
      res.status(500).json({ error: "Error al obtener inventario" });
    }
  });
  




module.exports=routerInventario;