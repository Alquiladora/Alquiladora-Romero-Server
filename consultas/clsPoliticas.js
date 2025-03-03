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

const routerPoliticas = express.Router();
routerPoliticas.use(express.json());
routerPoliticas.use(cookieParser());


// Obtener todas las políticas
routerPoliticas.get("/", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE tblpoliticas SET estado = 'no vigente' WHERE fechaVigencia < CURDATE() AND estado = 'vigente'"
    );

    // Seleccionar las políticas vigentes
    const [politicasVigentes] = await connection.query(
      "SELECT id FROM tblpoliticas WHERE estado = 'vigente' ORDER BY created_at DESC"
    );
    // Si hay más de una, actualizar todas menos la más reciente
    if (politicasVigentes.length > 1) {
      for (let i = 1; i < politicasVigentes.length; i++) {
        await connection.query(
          "UPDATE tblpoliticas SET estado = 'no vigente' WHERE id = ?",
          [politicasVigentes[i].id]
        );
      }
    }

    const [politicas] = await connection.query(
      "SELECT * FROM tblpoliticas ORDER BY created_at DESC"
    );

    const parsedPoliticas = politicas.map((politica) => ({
      ...politica,
      versio: politica.versio ? politica.versio.toString() : null,
      secciones:
        typeof politica.secciones === "string"
          ? JSON.parse(politica.secciones)
          : [],
    }));

    res.json(parsedPoliticas);
  } catch (error) {
    console.error("Error al obtener las políticas:", error);
    res.status(500).json({ message: "No se pudo obtener las políticas." });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener una política para usuarios finales (sin autenticación)
routerPoliticas.get("/vigente", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [terminos] = await connection.query(`
      SELECT * 
      FROM tblpoliticas 
      WHERE estado = 'vigente' 
        AND CURDATE() <= fechaVigencia 
      ORDER BY versio DESC 
      LIMIT 1
    `);
    if (terminos.length === 0) {
      return res.status(404).json({ error: "No hay Políticas vigentes" });
    }
    res.json(terminos[0]);
  } catch (error) {
    console.error("Error al obtener Política vigente:", error);
    res.status(500).json({ error: "No se pudo obtener la Política vigente" });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener una política por su ID
routerPoliticas.get("/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [termino] = await connection.query(
      "SELECT * FROM tblpoliticas WHERE id = ?",
      [id]
    );
    if (termino.length === 0) {
      return res.status(404).json({ error: "Política no encontrada" });
    }
    res.json(termino[0]);
  } catch (error) {
    console.error("Error al obtener la Política:", error);
    res.status(500).json({ error: "No se pudo obtener la Política" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear una nueva política (versión 1.0 o incrementada)
routerPoliticas.post("/", csrfProtection, async (req, res) => {
  const { titulo, contenido, fechaVigencia, secciones } = req.body;

  if (!titulo || !contenido || !fechaVigencia) {
    return res.status(400).json({
      error: "Los campos título, contenido y fecha de vigencia son obligatorios",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query(
      "UPDATE tblpoliticas SET estado = 'no vigente' WHERE estado = 'vigente'"
    );

    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tblpoliticas"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tblpoliticas 
      (titulo, contenido, fechaVigencia, secciones, versio, estado, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'vigente', NOW(), NOW())
    `;
    await connection.query(insertQuery, [
      titulo,
      contenido,
      fechaVigencia,
      JSON.stringify(secciones || []),
      nuevaVersion,
    ]);

    await connection.commit();
    res.status(201).json({ message: "Política creada exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear la política:", error);
    res.status(500).json({ error: "No se pudo crear la política" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear una nueva versión de una política existente
routerPoliticas.post("/:id/nueva-version", csrfProtection, async (req, res) => {
  const { id } = req.params;
  const { titulo, contenido, fechaVigencia, secciones } = req.body;

  if (!titulo || !contenido || !fechaVigencia) {
    return res.status(400).json({
      error: "Los campos título, contenido y fecha de vigencia son obligatorios",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [records] = await connection.query(
      "SELECT * FROM tblpoliticas WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Política no encontrada" });
    }

    await connection.query(
      "UPDATE tblpoliticas SET estado = 'no vigente' WHERE id = ?",
      [id]
    );

    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tblpoliticas"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tblpoliticas 
      (titulo, contenido, fechaVigencia, secciones, versio, estado, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'vigente', NOW(), NOW())
    `;
    await connection.query(insertQuery, [
      titulo,
      contenido,
      fechaVigencia,
      JSON.stringify(secciones || []),
      nuevaVersion,
    ]);

    await connection.commit();
    res
      .status(201)
      .json({ message: "Nueva versión de la política creada exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear nueva versión:", error);
    res.status(500).json({ error: "No se pudo crear la nueva versión" });
  } finally {
    if (connection) connection.release();
  }
});

// Eliminar (marcar como eliminada) una política
routerPoliticas.delete("/:id", csrfProtection, async (req, res) => {
  const { id } = req.params;
  console.log("Eliminar politica", id)
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [records] = await connection.query(
      "SELECT * FROM tblpoliticas WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Política no encontrada" });
    }
    const politicaActual = records[0];

    await connection.query(
      "UPDATE tblpoliticas SET estado = 'eliminado' WHERE id = ?",
      [id]
    );

    if (politicaActual.estado === "vigente") {
      const [ultimaPolitica] = await connection.query(`
        SELECT * FROM tblpoliticas 
        WHERE estado = 'no vigente' AND fechaVigencia >= CURDATE() 
        ORDER BY fechaVigencia DESC, versio DESC 
        LIMIT 1
      `);
      if (ultimaPolitica.length > 0) {
        await connection.query(
          "UPDATE tblpoliticas SET estado = 'vigente' WHERE id = ?",
          [ultimaPolitica[0].id]
        );
      }
    }

    await connection.commit();
    res.json({ message: "Política marcada como eliminada exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al eliminar la política:", error);
    res.status(500).json({ error: "No se pudo eliminar la política" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = routerPoliticas;
