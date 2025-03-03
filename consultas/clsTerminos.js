const express = require("express");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const crypto = require("crypto");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");

const routerTerminos = express.Router();
routerTerminos.use(express.json());
routerTerminos.use(cookieParser());

// Obtener todos los términos
routerTerminos.get("/", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    // Actualizar estado a "no vigente" cuando la fecha de vigencia ya pasó
    await connection.query(
      "UPDATE tblterminos SET estado = 'no vigente' WHERE fechaVigencia < CURDATE() AND estado = 'vigente'"
    );

    // Seleccionar los términos vigentes
    const [terminosVigentes] = await connection.query(
      "SELECT id FROM tblterminos WHERE estado = 'vigente' ORDER BY created_at DESC"
    );

    // Si hay más de uno vigente, dejar solo el más reciente en estado 'vigente'
    if (terminosVigentes.length > 1) {
      for (let i = 1; i < terminosVigentes.length; i++) {
        await connection.query(
          "UPDATE tblterminos SET estado = 'no vigente' WHERE id = ?",
          [terminosVigentes[i].id]
        );
      }
    }

    // Obtener todos los términos en orden descendente por fecha de creación
    const [terminos] = await connection.query(
      "SELECT * FROM tblterminos ORDER BY created_at DESC"
    );

    // Asegurarnos de parsear correctamente la columna `secciones` si es JSON
    const parsedTerminos = terminos.map((termino) => ({
      ...termino,
      versio: termino.versio ? termino.versio.toString() : null,
      secciones:
        typeof termino.secciones === "string"
          ? JSON.parse(termino.secciones)
          : [],
    }));

    res.json(parsedTerminos);
  } catch (error) {
    console.error("Error al obtener los términos:", error);
    res.status(500).json({ message: "No se pudo obtener los términos." });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener el término vigente para usuarios finales (sin autenticación)
routerTerminos.get("/vigente", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [terminos] = await connection.query(`
      SELECT *
      FROM tblterminos
      WHERE estado = 'vigente'
        AND CURDATE() <= fechaVigencia
      ORDER BY versio DESC
      LIMIT 1
    `);
    if (terminos.length === 0) {
      return res.status(404).json({ error: "No hay Términos vigentes" });
    }
    res.json(terminos[0]);
  } catch (error) {
    console.error("Error al obtener Término vigente:", error);
    res.status(500).json({ error: "No se pudo obtener el Término vigente" });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener un término por su ID
routerTerminos.get("/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [termino] = await connection.query(
      "SELECT * FROM tblterminos WHERE id = ?",
      [id]
    );
    if (termino.length === 0) {
      return res.status(404).json({ error: "Término no encontrado" });
    }
    res.json(termino[0]);
  } catch (error) {
    console.error("Error al obtener el Término:", error);
    res.status(500).json({ error: "No se pudo obtener el Término" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear un nuevo término (versión 1.0 o incrementada)
routerTerminos.post("/", csrfProtection, async (req, res) => {
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

    // Marcar cualquier término vigente como no vigente
    await connection.query(
      "UPDATE tblterminos SET estado = 'no vigente' WHERE estado = 'vigente'"
    );

    // Buscar la última versión registrada para incrementarla
    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tblterminos"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tblterminos
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
    res.status(201).json({ message: "Término creado exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear el término:", error);
    res.status(500).json({ error: "No se pudo crear el término" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear una nueva versión de un término existente
routerTerminos.post("/:id/nueva-version", csrfProtection, async (req, res) => {
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

    // Bloquear el registro para forzar la transacción
    const [records] = await connection.query(
      "SELECT * FROM tblterminos WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Término no encontrado" });
    }

    // Poner el actual en estado 'no vigente'
    await connection.query(
      "UPDATE tblterminos SET estado = 'no vigente' WHERE id = ?",
      [id]
    );

    // Determinar la siguiente versión
    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tblterminos"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tblterminos
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
      .json({ message: "Nueva versión del Término creada exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear nueva versión:", error);
    res.status(500).json({ error: "No se pudo crear la nueva versión" });
  } finally {
    if (connection) connection.release();
  }
});

// Eliminar (marcar como eliminado) un término
routerTerminos.delete("/:id", csrfProtection, async (req, res) => {
  const { id } = req.params;
  console.log("Eliminar término", id);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Bloquear el registro para forzar la transacción
    const [records] = await connection.query(
      "SELECT * FROM tblterminos WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Término no encontrado" });
    }

    const terminoActual = records[0];

    // Marcar como eliminado
    await connection.query(
      "UPDATE tblterminos SET estado = 'eliminado' WHERE id = ?",
      [id]
    );

    // Si el término eliminado estaba vigente, buscar otro término para reactivar
    if (terminoActual.estado === "vigente") {
      const [ultimoTermino] = await connection.query(`
        SELECT *
        FROM tblterminos
        WHERE estado = 'no vigente'
          AND fechaVigencia >= CURDATE()
        ORDER BY fechaVigencia DESC, versio DESC
        LIMIT 1
      `);
      if (ultimoTermino.length > 0) {
        await connection.query(
          "UPDATE tblterminos SET estado = 'vigente' WHERE id = ?",
          [ultimoTermino[0].id]
        );
      }
    }

    await connection.commit();
    res.json({ message: "Término marcado como eliminado exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al eliminar el término:", error);
    res.status(500).json({ error: "No se pudo eliminar el término" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = routerTerminos;
