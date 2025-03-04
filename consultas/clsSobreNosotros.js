// routerSobreNosotros.js
const express = require("express");
const cookieParser = require("cookie-parser");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");

const routerSobreNosotros = express.Router();
routerSobreNosotros.use(express.json());
routerSobreNosotros.use(cookieParser());

routerSobreNosotros.get("/", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
  
    const [rows] = await connection.query(
      "SELECT * FROM tblsobrenosotros ORDER BY id ASC LIMIT 1"
    );

    if (rows.length === 0) {
      
      return res.json({});
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error("Error al obtener la información de SobreNosotros:", error);
    res
      .status(500)
      .json({ error: "No se pudo obtener la información de SobreNosotros" });
  } finally {
    if (connection) connection.release();
  }
});


routerSobreNosotros.post("/", csrfProtection, async (req, res) => {
  const { quienesSomos, nuestraHistoria } = req.body;

  if (!quienesSomos || !nuestraHistoria) {
    return res.status(400).json({
      error: "Los campos 'quienesSomos' y 'nuestraHistoria' son obligatorios",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    
    const [rowsCheck] = await connection.query(
      "SELECT id FROM tblsobrenosotros LIMIT 1"
    );

    if (rowsCheck.length > 0) {
    
      return res
        .status(409)
        .json({ error: "Ya existe información de 'Sobre Nosotros'" });
    }

    // Si no existe, creamos un nuevo registro
    await connection.query(
      `INSERT INTO tblsobrenosotros (quienesSomos, nuestraHistoria) VALUES (?, ?)`,
      [quienesSomos, nuestraHistoria]
    );

    res.status(201).json({ message: "Información de 'Sobre Nosotros' creada" });
  } catch (error) {
    console.error("Error al crear 'Sobre Nosotros':", error);
    res.status(500).json({ error: "No se pudo crear la información" });
  } finally {
    if (connection) connection.release();
  }
});


routerSobreNosotros.put("/:id", csrfProtection, async (req, res) => {
  const { id } = req.params;
  const { quienesSomos, nuestraHistoria } = req.body;

  if (!quienesSomos || !nuestraHistoria) {
    return res.status(400).json({
      error: "Los campos 'quienesSomos' y 'nuestraHistoria' son obligatorios",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();

   
    const [rowsCheck] = await connection.query(
      "SELECT id FROM tblsobrenosotros WHERE id = ?",
      [id]
    );

    if (rowsCheck.length === 0) {
      return res
        .status(404)
        .json({ error: "No se encontró la información de 'Sobre Nosotros'" });
    }

    
    await connection.query(
      `
        UPDATE tblsobrenosotros
        SET quienesSomos = ?, nuestraHistoria = ?
        WHERE id = ?
      `,
      [quienesSomos, nuestraHistoria, id]
    );

    res.json({ message: "Información actualizada exitosamente" });
  } catch (error) {
    console.error("Error al actualizar 'Sobre Nosotros':", error);
    res.status(500).json({ error: "No se pudo actualizar la información" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = routerSobreNosotros;
