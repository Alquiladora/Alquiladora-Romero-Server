const express = require("express");
const { pool } = require("../connectBd");
const HorarioRouter = express.Router();
HorarioRouter.use(express.json());
const { csrfProtection } = require("../config/csrf");
const moment = require("moment");


const validateTimeFormat = (time) => {
  if (!time) return true; 
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
};


HorarioRouter.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM tblhorario ORDER BY FIELD(day, 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo')"
    );
    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error(`[${moment().format("YYYY-MM-DD HH:mm:ss")}] Error al obtener el horario:`, error);
    res.status(500).json({
      success: false,
      message: "Error al obtener el horario.",
      error: error.message,
    });
  }
});



HorarioRouter.put("/:day", csrfProtection, async (req, res) => {
  const { day } = req.params;
  const { open, close } = req.body;

  const validDays = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  if (!validDays.includes(day)) {
    return res.status(400).json({
      success: false,
      message: "El día especificado no es válido. Debe ser un día de la semana en español (ej. 'Lunes').",
    });
  }

  if (!validateTimeFormat(open) || !validateTimeFormat(close)) {
    return res.status(400).json({
      success: false,
      message: "Las horas deben tener el formato HH:mm (ej. 09:00) o ser nulas.",
    });
  }



  if (open && close) {
    const start = new Date(`1970-01-01T${open}:00`);
    const end = new Date(`1970-01-01T${close}:00`);
    if (end <= start) {
      return res.status(400).json({
        success: false,
        message: "La hora de cierre debe ser posterior a la hora de apertura.",
      });
    }
  }

  try {
    
    const [existing] = await pool.query("SELECT * FROM tblhorario WHERE day = ?", [day]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Día no encontrado en el horario.",
      });
    }

  
    const query = "UPDATE tblhorario SET open = ?, close = ? WHERE day = ?";
    const values = [open || null, close || null, day];

    await pool.query(query, values);

    res.status(200).json({
      success: true,
      message: "Horario actualizado exitosamente.",
      data: { day, open, close },
    });
  } catch (error) {
    console.error(`[${moment().format("YYYY-MM-DD HH:mm:ss")}] Error al actualizar el horario:`, error);
    res.status(500).json({
      success: false,
      message: "Error al actualizar el horario.",
      error: error.message,
    });
  }
});



module.exports = HorarioRouter;