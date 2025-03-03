const express = require("express");
const cookieParser = require("cookie-parser");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");

const routerDeslindes = express.Router();
routerDeslindes.use(express.json());
routerDeslindes.use(cookieParser());

// Obtener todos los deslindes
routerDeslindes.get("/", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE tbldeslindes SET estado = 'no vigente' WHERE fechaVigencia < CURDATE() AND estado = 'vigente'"
    );

    // Seleccionar los deslindes vigentes
    const [deslindesVigentes] = await connection.query(
      "SELECT id FROM tbldeslindes WHERE estado = 'vigente' ORDER BY created_at DESC"
    );

    // Si hay más de uno vigente, dejar solo el más reciente en estado 'vigente'
    if (deslindesVigentes.length > 1) {
      for (let i = 1; i < deslindesVigentes.length; i++) {
        await connection.query(
          "UPDATE tbldeslindes SET estado = 'no vigente' WHERE id = ?",
          [deslindesVigentes[i].id]
        );
      }
    }

    // Obtener todos los deslindes en orden descendente por fecha de creación
    const [deslindes] = await connection.query(
      "SELECT * FROM tbldeslindes ORDER BY created_at DESC"
    );

    // Asegurarnos de parsear la columna `secciones` si es JSON
    const parsedDeslindes = deslindes.map((deslinde) => ({
      ...deslinde,
      versio: deslinde.versio ? deslinde.versio.toString() : null,
      secciones:
        typeof deslinde.secciones === "string"
          ? JSON.parse(deslinde.secciones)
          : [],
    }));

    res.json(parsedDeslindes);
  } catch (error) {
    console.error("Error al obtener los deslindes:", error);
    res.status(500).json({ message: "No se pudo obtener los deslindes." });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener el deslinde vigente para usuarios finales (sin autenticación)
routerDeslindes.get("/vigente", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [deslindes] = await connection.query(`
      SELECT *
      FROM tbldeslindes
      WHERE estado = 'vigente'
        AND CURDATE() <= fechaVigencia
      ORDER BY versio DESC
      LIMIT 1
    `);
    if (deslindes.length === 0) {
      return res.status(404).json({ error: "No hay Deslindes vigentes" });
    }
    res.json(deslindes[0]);
  } catch (error) {
    console.error("Error al obtener Deslinde vigente:", error);
    res.status(500).json({ error: "No se pudo obtener el Deslinde vigente" });
  } finally {
    if (connection) connection.release();
  }
});

// Obtener un deslinde por su ID
routerDeslindes.get("/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [deslinde] = await connection.query(
      "SELECT * FROM tbldeslindes WHERE id = ?",
      [id]
    );
    if (deslinde.length === 0) {
      return res.status(404).json({ error: "Deslinde no encontrado" });
    }
    res.json(deslinde[0]);
  } catch (error) {
    console.error("Error al obtener el Deslinde:", error);
    res.status(500).json({ error: "No se pudo obtener el Deslinde" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear un nuevo deslinde (versión 1.0 o incrementada)
routerDeslindes.post("/", csrfProtection, async (req, res) => {
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

    // Marcar cualquier deslinde vigente como no vigente
    await connection.query(
      "UPDATE tbldeslindes SET estado = 'no vigente' WHERE estado = 'vigente'"
    );

    // Buscar la última versión registrada para incrementarla
    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tbldeslindes"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tbldeslindes
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
    res.status(201).json({ message: "Deslinde creado exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear el deslinde:", error);
    res.status(500).json({ error: "No se pudo crear el deslinde" });
  } finally {
    if (connection) connection.release();
  }
});

// Crear una nueva versión de un deslinde existente
routerDeslindes.post("/:id/nueva-version", csrfProtection, async (req, res) => {
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

    // Bloquear el registro actual para la transacción
    const [records] = await connection.query(
      "SELECT * FROM tbldeslindes WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Deslinde no encontrado" });
    }

    // Poner el actual en estado 'no vigente'
    await connection.query(
      "UPDATE tbldeslindes SET estado = 'no vigente' WHERE id = ?",
      [id]
    );

    // Determinar la siguiente versión
    const [rows] = await connection.query(
      "SELECT MAX(versio) as ultimaVersion FROM tbldeslindes"
    );
    const ultimaVersion = rows[0].ultimaVersion;
    const nuevaVersion = ultimaVersion
      ? (parseFloat(ultimaVersion) + 1.0).toFixed(1)
      : "1.0";

    const insertQuery = `
      INSERT INTO tbldeslindes
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
      .json({ message: "Nueva versión del Deslinde creada exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al crear nueva versión:", error);
    res.status(500).json({ error: "No se pudo crear la nueva versión" });
  } finally {
    if (connection) connection.release();
  }
});

// Eliminar (marcar como eliminado) un deslinde
routerDeslindes.delete("/:id", csrfProtection, async (req, res) => {
  const { id } = req.params;
  console.log("Eliminar deslinde", id);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Bloquear el registro para forzar la transacción
    const [records] = await connection.query(
      "SELECT * FROM tbldeslindes WHERE id = ? FOR UPDATE",
      [id]
    );
    if (records.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Deslinde no encontrado" });
    }

    const deslindeActual = records[0];

    // Marcar como eliminado
    await connection.query(
      "UPDATE tbldeslindes SET estado = 'eliminado' WHERE id = ?",
      [id]
    );

    // Si el deslinde eliminado estaba vigente, buscar otro para reactivar
    if (deslindeActual.estado === "vigente") {
      const [ultimoDeslinde] = await connection.query(`
        SELECT *
        FROM tbldeslindes
        WHERE estado = 'no vigente'
          AND fechaVigencia >= CURDATE()
        ORDER BY fechaVigencia DESC, versio DESC
        LIMIT 1
      `);
      if (ultimoDeslinde.length > 0) {
        await connection.query(
          "UPDATE tbldeslindes SET estado = 'vigente' WHERE id = ?",
          [ultimoDeslinde[0].id]
        );
      }
    }

    await connection.commit();
    res.json({ message: "Deslinde marcado como eliminado exitosamente" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error al eliminar el deslinde:", error);
    res.status(500).json({ error: "No se pudo eliminar el deslinde" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = routerDeslindes;
