const express = require("express");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const winston = require("winston");
const crypto = require("crypto");
const { csrfProtection } = require("../config/csrf");
const moment = require("moment-timezone");
const cron = require("node-cron");
const otplib = require("otplib");
const qrcode = require("qrcode");

const { pool } = require("../connectBd");
const { getIO, getUserSockets } = require("../config/socket");
const usuarioRouter = express.Router();
usuarioRouter.use(express.json());
usuarioRouter.use(cookieParser());
const userSockets = getUserSockets();

//Variables para el ip
const SECRET_KEY = process.env.SECRET_KEY.padEnd(32, " ");
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TIME = 10 * 60 * 1000;
const TOKEN_EXPIRATION_TIME = 24 * 60 * 60 * 1000;

//importamos el recaptchat

const { VeryfyRecapcha } = require("../config/recapcha");

// Configurar winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

if (!process.env.SECRET_KEY) {
  throw new Error("La variable de entorno SECRET_KEY no está definida.");
}

//========================COOKIES================================================


//Funcion  para obtener la fecha actual
function obtenerFechaMexico() {
  return moment().tz("America/Mexico_City").format("YYYY-MM-DD HH:mm:ss");
}

//=============================REGISTRO=============================
usuarioRouter.post("/registro", csrfProtection, async (req, res, next) => {
  const { nombre, apellidoP, apellidoM, correo, telefono, password } = req.body;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (!password) {
      return res.status(400).json({ message: "La contraseña es obligatoria" });
    }

    const capitalizeFirstLetter = (str) =>
      str?.charAt(0).toUpperCase() + str.slice(1).toLowerCase() || "";

    const nombreFormateado = capitalizeFirstLetter(nombre);
    const apellidoPFormateado = capitalizeFirstLetter(apellidoP);
    const apellidoMFormateado = capitalizeFirstLetter(apellidoM);

    const hashedPassword = await argon2.hash(password);
    const fechaCreacion = obtenerFechaMexico();

    const [noCliente] = await connection.query(
      `SELECT idNoClientes FROM tblnoclientes WHERE correo = ? OR telefono = ? LIMIT 1`,
      [correo, telefono]
    );

    if (!noCliente.length) {
      console.log(
        "Cliente no encontrado en tblnoclientes, este cliente es nuevo"
      );
    }

    const insertUserQuery = `
      INSERT INTO tblusuarios 
      (nombre, apellidoP, apellidoM, correo, telefono, password, rol, estado, multifaltor, fechaCreacion) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await connection.query(insertUserQuery, [
      nombreFormateado,
      apellidoPFormateado,
      apellidoMFormateado,
      correo,
      telefono,
      hashedPassword,
      "cliente",
      1,
      null,
      fechaCreacion,
    ]);

    const insertId = result.insertId;

    if (!insertId) {
      await connection.rollback();
      return res.status(500).json({ message: "Error al registrar usuario" });
    }

    if (noCliente.length > 0) {
      console.log("Estos datos son de idNoclientes", noCliente[0].idNoClientes);

      const [pedidos] = await connection.query(
        `SELECT idDireccion FROM tblpedidos 
         WHERE idNoClientes = ? 
         AND LOWER(estado) IN ('finalizado', 'cancelado','perdido','incidencia','incompleto')`,
        [noCliente[0].idNoClientes]
      );
      console.log("valor de idDireccion", pedidos);

      if (pedidos.length > 0) {
        await connection.query(
          `UPDATE tblpedidos 
           SET idDireccion = NULL 
           WHERE idNoClientes = ? 
           AND estado IN ('finalizado', 'cancelado')`,
          [noCliente[0].idNoClientes]
        );

        await connection.query(
          `DELETE FROM tbldireccioncliente WHERE idNoClientes = ?`,
          [noCliente[0].idNoClientes]
        );
      }

      await connection.query(
        `UPDATE tblnoclientes SET idUsuario = ? WHERE idNoClientes = ?`,
        [insertId, noCliente[0].idNoClientes]
      );

      await connection.query(
        `UPDATE tblnoclientes SET idUsuario = ?, nombre = NULL, apellidoCompleto = NULL, correo = NULL, telefono = NULL 
        WHERE idNoClientes = ?`,
        [insertId, noCliente[0].idNoClientes]
      );
    }

    const queryPerfil = `INSERT INTO tblperfilusuarios (idUsuarios, fotoPerfil) VALUES (?, NULL)`;
    await connection.query(queryPerfil, [insertId]);

    await connection.commit();

    const [usuarios] = await pool.query(
      `SELECT COUNT(*) AS totalUsuarios FROM tblusuarios`
    );
    const totalUsuarios = usuarios[0].totalUsuarios;
    getIO().emit("totalUsuarios", { totalUsuarios });

    res.status(201).json({
      message: "Usuario creado exitosamente",
      userId: insertId,
    });
  } catch (error) {
    console.error("Error en el registro:", error);
    if (connection) await connection.rollback();
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

//=====================CONSULTA DE USUARIOS===============================
//Obtenemos Todos Los Usuarios
usuarioRouter.get("/", async (req, res, next) => {
  try {
    const [usuarios] = await pool.query("SELECT * FROM tblusuarios");
    res.json(usuarios);
  } catch (error) {
    next(error);
  }
});

///==========================================================================================================================================================================================

//====================LOGIN=================================================
usuarioRouter.post("/login", async (req, res, next) => {
  try {
    const { email, contrasena, tokenMFA, deviceType, captchaToken, ip } =
      req.body;

      console.log("datos recibidos desde login ",email, contrasena, )
    const clientTimestamp = obtenerFechaMexico();

    if (!email || !contrasena) {
      return res
        .status(400)
        .json({ message: "Email y contraseña son obligatorios." });
    }
    if (!captchaToken) {
      return res.status(400).json({ message: "Token de reCAPTCHA requerido." });
    }
    if (!ip || !deviceType) {
      return res
        .status(400)
        .json({ message: "IP y tipo de dispositivo son obligatorios." });
    }

    const recaptchaResult = await VeryfyRecapcha(captchaToken, "login", 0.5);
    if (!recaptchaResult.success) {
      return res
        .status(400)
        .json({ message: "Validación de reCAPTCHA fallida." });
    }

    console.log("Resultado de reCAPTCHA (login):", recaptchaResult);

    const cookiesId = uuidv4();

    if (!pool) {
      throw new Error("La conexión a la base de datos no está disponible.");
    }

    const [result] = await pool.query(
      "SELECT * FROM tblusuarios WHERE correo = ?",
      [email]
    );

    if (!Array.isArray(result) || result.length === 0) {
      console.log("Credenciales Incorrectas");
      return res.status(401).json({ message: "Credenciales Incorrectas" });
    }

    const usuario = result[0];

    //===================================================================================================

      // ==== BLOQUEO ====
    // Si verificarBloqueo envía res, salimos
    if (await VerificarBloqueo(usuario, res)) {
      return;
    }
    //================================================================================
    // Comparar la contraseña con la base de datos
    const validPassword = await argon2.verify(usuario.password, contrasena);

    if (!validPassword) {
      await handleFailedAttempt(ip, usuario.idUsuarios, pool);

      return res.status(401).json({ message: "Credenciales Incorrectos" });
    }
    //==============================================================MFA ATIVADO=====================
    console.log("Este es e multifactor", usuario.multifaltor);
    console.log("Datos de tokenMfa", tokenMFA)

    if (usuario.multifaltor) {
      if (!tokenMFA) {
        return res.status(200).json({
          message:
            "MFA requerido. Por favor ingresa el código de verificación MFA.",
          mfaRequired: true,
          userId: usuario.idUsuarios,
        });
      }
      // Si se recibió un tokenMFA, verificarlo
      const isValidMFA = otplib.authenticator.check(
        tokenMFA,
        usuario.multifaltor
      );

      console.log("Datos a mostra de mfa para validar",isValidMFA);
      
      if (!isValidMFA) {
        return res.status(400).json({ message: "Código MFA incorrecto." });
      }
    }

    // Generar token JWT
    const token = jwt.sign(
      { id: usuario.idUsuarios, nombre: usuario.nombre, rol: usuario.rol },
      SECRET_KEY,
      { expiresIn: "24h" }
    );

    // Crear la cookie de sesión
    res.cookie("sesionToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "local",
      sameSite: "None",
      maxAge: TOKEN_EXPIRATION_TIME,
    });

    // Insertar la sesión en tblsesiones
    try {
     
     
      await pool.query(`
      INSERT INTO tblsesiones 
        (idUsuarios, tokenSesion, horaInicio, direccionIP, tipoDispositivo, cookie, horaFin)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `, 
        [ usuario.idUsuarios,cookiesId,clientTimestamp,ip,deviceType,token]);
      console.log(`Sesión insertada en tblsesiones para usuario ${usuario.idUsuarios}`);
    } catch (insertError) {
      console.error("Error al insertar la sesión en tblsesiones:", insertError);
      next(error);
    }

    if (usuario && usuario.idUsuarios) {
      const userSocket = userSockets[usuario.idUsuarios];
      if (userSocket) {
        userSocket.emit("usuarioAutenticado", {
          idUsuarios: usuario.idUsuarios,
        });
      } else {
        console.log(
          `⚠️ Usuario ${usuario.idUsuarios} no tiene un socket activo.`
        );
      }
    } else {
      console.log("El objeto usuario no tiene la propiedad idUsuarios");
    }

    // Responder con éxito
    res.json({
      message: "Login exitoso",
      user: {
        idUsuarios: usuario.idUsuarios,
        nombre: usuario.nombre,
        rol: usuario.rol,
      },
    });

    console.log("Login exitoso");
  } catch (error) {
    console.error("Error en el login:", error);
    next(error);
  }
});


//=============================FUNCION DE BLOQUEO
async function VerificarBloqueo(usuario, res) {
   const [bloqueos] = await pool.query(
      "SELECT intentos, bloqueado, lock_until FROM tblipbloqueados WHERE idUsuarios = ?",
      [usuario.idUsuarios]
    );

    if (bloqueos.length > 0) {
      const bloqueo = bloqueos[0];
      const ahora = new Date();

      const lockUntil = bloqueo.lock_until ? new Date(bloqueo.lock_until) : null;

      if (bloqueos.bloqueado === 1) {
        return res.status(403).json({
          message: "Cuenta bloqueada por el administrador.",
        });
      }

      if (lockUntil && lockUntil <= ahora) {
        console.log(  "El tiempo de bloqueo ha expirado. Desbloqueando usuario..." );

        await pool.query( ` UPDATE tblipbloqueados SET intentos = 0, lock_until = NULL  WHERE idUsuarios = ?`,
         [usuario.idUsuarios]);
       
        bloqueo.intentos = 0;
        bloqueo.lock_until = null;
        console.log(`Usuario ${usuario.idUsuarios} desbloqueado correctamente.`);
      }else if (bloqueo.intentos >= MAX_FAILED_ATTEMPTS) {
        if (!lockUntil) {
          const lockTime = new Date(ahora.getTime() + LOCK_TIME);
          await pool.query(` UPDATE tblipbloqueados SET lock_until = ? WHERE idUsuarios = ?`,
             [lockTime, usuario.idUsuarios]);
          bloqueo.lock_until = lockTime;
        }

        const tiempoRestanteSegundos = Math.ceil((new Date(bloqueo.lock_until) - ahora) / 1000);
        const tiempoRestanteMensaje = tiempoRestanteSegundos >= 60
        ? `${Math.floor(tiempoRestanteSegundos / 60)} minuto${tiempoRestanteSegundos >= 120 ? 's' : ''}${
            tiempoRestanteSegundos % 60 > 0 ? ` y ${tiempoRestanteSegundos % 60} segundo${tiempoRestanteSegundos % 60 !== 1 ? 's' : ''}` : ''
          }`
        : `${tiempoRestanteSegundos} segundo${tiempoRestanteSegundos !== 1 ? 's' : ''}`;


        return res.status(403).json({
          message: `Usuario bloqueado temporalmente. Inténtalo de nuevo en ${tiempoRestanteMensaje}.`,
          tiempoRestante: tiempoRestanteSegundos,
        });
      }
    }

   return false;
}

//================================Manejo de intentos fallidos de login=======================================
async function handleFailedAttempt(ip, idUsuarios, pool) {
  try {
    // Obtener la fecha y hora actual
    const currentDate = new Date();
    const fechaActual = currentDate.toISOString().split("T")[0];
    const horaActual = currentDate.toTimeString().split(" ")[0];

    // Consultar si ya existe un bloqueo para este usuario
    const [result] = await pool.query(
      "SELECT intentos, intentosReales FROM tblipbloqueados WHERE idUsuarios = ?",
      [idUsuarios]
    );

    console.log("Bloqueado23", result);

    if (result.length === 0) {
      // Si no hay registros, insertamos uno nuevo
      await pool.query(
        "INSERT INTO tblipbloqueados (idUsuarios, ip, fecha, hora, intentos, intentosReales,bloqueado) VALUES (?, ?, ?, ?, ?, ?, ? )",
        [idUsuarios, ip, fechaActual, horaActual, 1, 1, 0]
      );
      logger.info(
        `Registro de bloqueo creado para el usuario con ID ${idUsuarios}`
      );
    } else {
      const { intentos, intentosReales } = result[0];
      const newAttempts = intentos + 1;
      const newIntentosReales = intentosReales + 1;

      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCK_TIME);
        await pool.query(
          "UPDATE tblipbloqueados SET intentos = ?, intentosReales = ?, fecha = ?, hora = ?, lock_until = ? WHERE idUsuarios = ?",
          [
            newAttempts,
            newIntentosReales,
            fechaActual,
            horaActual,
            lockUntil,
            idUsuarios,
          ]
        );
        logger.info(
          `Usuario ${idUsuarios} ha alcanzado el número máximo de intentos. Bloqueado hasta ${lockUntil}`
        );
      } else {
        await pool.query(
          "UPDATE tblipbloqueados SET intentos = ?, intentosReales = ?, fecha = ?, hora = ? WHERE idUsuarios = ?",
          [newAttempts, newIntentosReales, fechaActual, horaActual, idUsuarios]
        );
        logger.info(
          `Usuario ${idUsuarios} ha fallado otro intento. Total intentos fallidos: ${newAttempts}`
        );
      }
    }
    logger.warn(
      `Intento fallido desde IP: ${ip}  para el usuario con ID ${idUsuarios}`
    );
  } catch (error) {
    if (error.code === "ECONNRESET") {
      logger.error(
        `Error de conexión a la base de datos (ECONNRESET) al manejar intento fallido para usuario ${idUsuarios}`
      );
      throw new Error(
        "Error de conexión a la base de datos. Por favor, intenta de nuevo más tarde."
      );
    }
    logger.error(
      `Error al manejar intento fallido para usuario ${idUsuarios}: ${error.message}`
    );
    throw error;
  }
}

///==========================================================================================================================================================================================
//====================Consulta de perfil de usuario========================================================0
//Middleware para validar token
const verifyToken = async (req, res, next) => {

  try{
     const token = req.cookies?.sesionToken;

   if (!token) {
      return res.status(403).json({ message: "Token no proporcionado. Acceso denegado." });
    }
  
    const decoded = jwt.verify(token, SECRET_KEY);
    
    const sessionQuery = `
       SELECT 1 FROM tblsesiones 
      WHERE idUsuarios = ? AND cookie = ? AND horaFin IS NULL
      LIMIT 1
      
    `;

    const [sessions] = await pool.query(sessionQuery, [decoded.id, token]);
    
    if (sessions.length === 0) {
      return res.status(401).json({
        message:
          "Sesión inválida o expirada. Por favor, inicia sesión nuevamente.",
      });
    }

   req.user = {
      id: decoded.id,
      nombre: decoded.nombre,
      rol: decoded.rol,
    };


    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ message: "El token ha expirado. Inicia sesión nuevamente." });
    }

    return res.status(500).json({ message: "Error en la autenticación." });
  }
};

// Ruta protegida
usuarioRouter.get("/perfil", verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const query = `
    SELECT 
      u.nombre, 
      u.apellidoP, 
      u.apellidoM, 
      u.correo, 
      u.telefono, 
      u.rol, 
      u.multifaltor, 
      u.fechaCreacion,
      p.direccion,
      p.fechaNacimiento,
      p.fotoPerfil,
      p.fechaActualizacionF
    FROM 
      tblusuarios u
    LEFT JOIN 
      tblperfilusuarios p
    ON 
      u.idUsuarios = p.idUsuarios
    WHERE 
      u.idUsuarios = ?;
  `;

    const [result] = await pool.query(query, [userId]);

    if (result.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    const usuario = result[0];

    res.json({
      message: "Perfil obtenido correctamente",
      user: {
        idUsuarios: userId,
        nombre: usuario.nombre,
        apellidoP: usuario.apellidoP,
        apellidoM: usuario.apellidoM,
        correo: usuario.correo,
        telefono: usuario.telefono,
        rol: usuario.rol,
        multifaltor: usuario.multifaltor,
        direccion: usuario.direccion,
        fechaNacimiento: usuario.fechaNacimiento,
        fotoPerfil: usuario.fotoPerfil,
        fechaActualizacionF: usuario.fechaActualizacionF,
        fechaCreacion: usuario.fechaCreacion,
      },
    });
  } catch (error) {
    console.error("Error al obtener el perfil del usuario:", error);
    res
      .status(500)
      .json({ message: "Error al obtener el perfil del usuario." });
  }
});


//Perfil inicio
usuarioRouter.get("/perfil-simple", verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const query = `
      SELECT nombre, fotoPerfil
      FROM tblusuarios u
      LEFT JOIN tblperfilusuarios p ON u.idUsuarios = p.idUsuarios
      WHERE u.idUsuarios = ?;
    `;

    const [result] = await pool.query(query, [userId]);

    if (result.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    const usuario = result[0];
    const nombre = usuario.nombre || "Usuario";
    const fotoPerfil = usuario.fotoPerfil ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(nombre.charAt(0))}`;

    res.json({
      message: "Datos básicos de perfil obtenidos correctamente",
      user: {
        nombre,
        fotoPerfil,
      },
    });
  } catch (error) {
    console.error("Error al obtener datos básicos del perfil:", error);
    res.status(500).json({ message: "Error al obtener datos básicos del perfil." });
  }
});


//CCERRAMOS SESION
usuarioRouter.post("/Delete/login", csrfProtection,verifyToken, async (req, res) => {
  const token = req.cookies.sesionToken;
  const HoraFinal = obtenerFechaMexico();
  console.log("ESte es el tookie que recibe", token);
  if (!token) {
    return res.status(400).json({ message: "No hay sesión activa." });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const query = `
    UPDATE tblsesiones
    SET horaFin = ?
     WHERE idUsuarios = ?
        AND cookie = ?
        AND horaFin IS NULL
    `;

    const [result] = await pool.query(query, [HoraFinal, userId, token]);

    if (result.affectedRows === 0) {
      console.warn("⚠️ No se encontró una sesión activa para actualizar.");
    } else {
      console.log("✅ horaFin actualizada correctamente.");
    }
    res.clearCookie("sesionToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "local",
      sameSite: "None",
    });
    console.log("sesion cerrada correctamente");
    res.json({ message: "Sesión cerrada correctamente." });
  } catch (error) {
    console.error("Error al cerrar la sesión:", error);
    res.status(500).json({ message: "Error al cerrar la sesión." });
  }
});

//CeRRAR TODAS LAS CESIONES
usuarioRouter.post(
  "/Delete/login/all-except-current",
  csrfProtection,verifyToken,
  async (req, res) => {
    const token = req.cookies.sesionToken;
    const HoraFinal = obtenerFechaMexico();

    if (!token) {
      return res.status(401).json({ message: "No hay sesión activa." });
    }

    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const userId = decoded.id;
      const query = `
      UPDATE tblsesiones
      SET horaFin = ?
      WHERE idUsuarios = ? AND horaFin IS NULL AND cookie != ?
    `;

      const [result] = await pool.query(query, [HoraFinal, userId, token]);

      if (result.affectedRows === 0) {
        console.warn(
          "⚠️ No se encontraron sesiones activas para cerrar (excepto la actual)."
        );
        return res
          .status(404)
          .json({
            message: "No hay sesiones activas adicionales para cerrar.",
          });
      } else {
        console.log(
          `✅ ${result.affectedRows} sesiones cerradas correctamente.`
        );
      }

      res.json({
        message: `Se cerraron ${result.affectedRows} sesiones activas excepto la actual.`,
      });
    } catch (error) {
      console.error("❌ Error al cerrar sesiones:", error);
      res.status(500).json({ message: "Error interno al cerrar sesiones." });
    }
  }
);

//Sesiones
usuarioRouter.post("/sesiones", csrfProtection,verifyToken, async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: "El userId es obligatorio." });
  }
  try {
    if (!pool) {
      return res
        .status(500)
        .json({ message: "Error de conexión con la base de datos." });
    }
    // Obtener todas las sesiones activas del usuario
    const [sessions] = await pool.query(
      `
          SELECT 
              idSesion AS id,
              idUsuarios,
              direccionIP,
              horaInicio,
              horaFin,
              tokenSesion,
              tipoDispositivo,
              cookie
          FROM tblsesiones
          WHERE idUsuarios = ? AND horaFin IS NULL
          `,
      [userId]
    );

    if (!sessions || sessions.length === 0) {
      console.log("⚠️ No hay sesiones activas para este usuario.");
      return res.json([]);
    }

    const currentToken = req.cookies?.sesionToken?.trim();

    if (!currentToken) {
      console.warn("⚠️ No se encontró token en la cookie");
      return res.status(401).json({ message: "Sesión no encontrada." });
    }

    const sessionsWithCurrentFlag = sessions.map((session) => {
      const tokenDB = session.cookie ? session.cookie.trim() : "";
      return {
        ...session,
        isCurrent: tokenDB === currentToken,
      };
    });

    res.json(sessionsWithCurrentFlag);
  } catch (error) {
    console.error("❌ Error al obtener las sesiones del usuario:", error);
    res
      .status(500)
      .json({ message: "Error al obtener las sesiones del usuario." });
  }
});

///CODIGO MFA
usuarioRouter.post("/enable-mfa", async (req, res) => {
  try {
    const { userId } = req.body;

    // Buscar al usuario por su ID
    const [usuarios] = await pool.query(
      "SELECT * FROM tblusuarios WHERE idUsuarios = ?",
      [userId]
    );
    if (usuarios.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    const usuario = usuarios[0];

    // Generar la clave secreta para MFA
    const mfaSecret = otplib.authenticator.generateSecret();

    // Generar el enlace otpauth para Google Authenticator
    const otpauthURL = otplib.authenticator.keyuri(
      usuario.correo,
      "TU TOKEN ALQUILADORA ROMERO: ",
      mfaSecret
    );

    // Generar código QR
    const qrCode = await qrcode.toDataURL(otpauthURL);

    // Guardar la clave MFA en la base de datos
    await pool.query(
      "UPDATE tblusuarios SET multifaltor = ? WHERE idUsuarios = ?",
      [mfaSecret, usuario.idUsuarios]
    );

    // Enviar el código QR al cliente para que lo escanee
    res.json({
      message: "MFA habilitado correctamente.",
      qrCode,
    });
  } catch (error) {
    console.error("Error al habilitar MFA:", error);
    res.status(500).json({ message: "Error al habilitar MFA." });
  }
});

//============================================================================
//Actualizamos el foto de perfil
usuarioRouter.patch("/perfil/:id/foto",verifyToken, async (req, res) => {
  const userId = req.params.id;
  console.log("perfil", userId);
  const { fotoPerfil } = req.body;
  const fechaActualizacion = obtenerFechaMexico();

  console.log("perfil", fotoPerfil);
  if (!fotoPerfil) {
    return res.status(400).json({ message: "Falta la imagen de perfil." });
  }

  try {
    const query = `
      UPDATE tblperfilusuarios 
      SET fotoPerfil = ?, fechaActualizacionF = ? 
      WHERE idUsuarios = ?;
    `;
    const [updateResult] = await pool.query(query, [
      fotoPerfil,
      fechaActualizacion,
      userId,
    ]);

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }
    getIO().emit("actualizacionPerfil", {
      userId,
      tipo: "fotoPerfil",
      fotoPerfil,
    });
    res.json({
      message: "Foto de perfil actualizada correctamente.",
      fotoPerfil,
    });
  } catch (error) {
    console.error("Error al actualizar la foto de perfil:", error);
    res.status(500).json({ message: "Error al actualizar la foto de perfil." });
  }
});

//===============================================================================================
//Actulizar el dato de usaurio en especifico
usuarioRouter.patch("/perfil/:id/:field", csrfProtection,verifyToken, async (req, res) => {
  let { id, field } = req.params;
  let { value } = req.body;

  console.log("Datos recibidos:", { id, field, value });

  // Lista de campos permitidos
  const allowedFields = [
    "nombre",
    "apellidoP",
    "apellidoM",
    "telefono",
    "fechaNacimiento",
  ];

  if (!allowedFields.includes(field)) {
    return res
      .status(400)
      .json({ message: "Campo no permitido para actualización." });
  }

  // Formatear nombre y apellidos (Primera letra mayúscula, resto minúsculas)
  if (["nombre", "apellidoP", "apellidoM"].includes(field)) {
    value = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (field === "fechaNacimiento") {
      console.log("Fecha recibida en el backend:", value);

      const queryPerfil = `
        UPDATE tblperfilusuarios 
        SET fechaNacimiento = ? 
        WHERE idUsuarios = ?
      `;
      const [result] = await connection.query(queryPerfil, [value, id]);
      console.log("Resulltado de fecha n", result);

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res
          .status(404)
          .json({ message: "Perfil de usuario no encontrado." });
      }
    } else {
      const query = `UPDATE tblusuarios SET ${field} = ? WHERE idUsuarios = ?`;
      const [result] = await connection.query(query, [value, id]);

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
    }

    await connection.commit();
    getIO().emit("actualizacionPerfil", { userId: id, campo: field, value });
    res.json({
      message: `${field} actualizado correctamente`,
      updatedField: value,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`Error al actualizar ${field}:`, error);
    res.status(500).json({ message: `Error al actualizar ${field}.` });
  } finally {
    if (connection) connection.release();
  }
});

//======================================

//==================================================SOSPECHOSOS
usuarioRouter.get("/usuarios-sospechosos",verifyToken, async (req, res) => {
  const minIntentosReales =
    req.query.minIntentos !== undefined
      ? parseInt(req.query.minIntentos)
      : MAX_FAILED_ATTEMPTS;

  try {
    const [usuarios] = await pool.query(
      `SELECT u.idUsuarios, u.nombre, u.apellidoP, u.correo,u.rol,u.telefono,
              b.intentosReales AS IntentosReales,
              b.bloqueado
       FROM tblusuarios u
       JOIN tblipbloqueados b ON u.idUsuarios = b.idUsuarios
       WHERE b.intentosReales >= ? OR b.bloqueado = TRUE`,
      [minIntentosReales]
    );
    res.status(200).json(usuarios);
  } catch (error) {
    console.error("Error al obtener usuarios sospechosos:", error);
    res.status(500).json({ message: "Error al obtener usuarios sospechosos" });
  }
});

usuarioRouter.post("/bloquear/:idUsuario",verifyToken, async (req, res) => {
  const { idUsuario } = req.params;

  try {
    await pool.query(
      `UPDATE tblipbloqueados SET bloqueado = TRUE WHERE idUsuarios = ?`,
      [idUsuario]
    );
    console.log("Usuarios bloqeuado correcatmente ");
    res.status(200).json({ message: "Usuario bloqueado manualmente." });
  } catch (error) {
    console.error("Error al bloquear usuario:", error);
    res.status(500).json({ message: "Error al bloquear usuario." });
  }
});

usuarioRouter.post("/desbloquear/:idUsuario",verifyToken, async (req, res) => {
  const { idUsuario } = req.params;

  try {
    await pool.query(
      `UPDATE tblipbloqueados SET  bloqueado = FALSE, Intentos = 0,  lock_until = NULL WHERE idUsuarios = ?`,
      [idUsuario]
    );
    res.status(200).json({ message: "Usuario desbloqueado manualmente." });
  } catch (error) {
    console.error("Error al desbloquear usuario:", error);
    res.status(500).json({ message: "Error al desbloquear usuario." });
  }
});

usuarioRouter.post(
  "/validarToken/contrasena",
  csrfProtection,
  async (req, res, next) => {
    try {
      const { correo, token } = req.body;
      console.log("Datos recibido ", correo, token);

      if (!correo || !token) {
        return res
          .status(400)
          .json({ message: "Correo o token no proporcionado." });
      }

      // Buscar el token en la tabla tbltokens
      const queryToken =
        "SELECT * FROM tbltokens WHERE correo = ? AND token = ?";
      const [tokenRecords] = await pool.query(queryToken, [correo, token]);
      console.log("Este es el resultado del token", tokenRecords);

      if (!tokenRecords.length) {
        return res
          .status(400)
          .json({ message: "Token inválido o no encontrado." });
      }

      const tokenData = tokenRecords[0];

      // Convertir la fecha de expiración (formato "YYYY-MM-DD HH:mm:ss") a objeto Date
      const expirationDate = new Date(tokenData.fechaExpiracion);
      const currentTime = new Date();
      console.log("Toen exptrado", currentTime);
      console.log("Expirado desde db", expirationDate);

      if (currentTime > expirationDate) {
        return res.status(400).json({ message: "El token ha expirado." });
      }

      console.log(res.status(400), "este es el resultado de envio");

      // Eliminar el token (se corrigió "corrreo" por "correo")
      const deleteTokenQuery =
        "DELETE FROM tbltokens WHERE correo = ? AND token = ?";
      await pool.query(deleteTokenQuery, [correo, token]);

      console.log(res.status(200), "este es el resultado de envio");

      return res.status(200).json({
        message:
          "Token válido. Puede proceder con el cambio de contraseña. El token ha sido eliminado.",
      });
    } catch (error) {
      console.error("Error al validar el token:", error);
      return res.status(500).json({ message: "Error al validar el token." });
    }
  }
);

usuarioRouter.post("/verify-password", csrfProtection,verifyToken, async (req, res) => {
  const { idUsuario, currentPassword } = req.body;

  if (!idUsuario || !currentPassword) {
    return res
      .status(400)
      .json({ message: "ID de usuario o contraseña no proporcionados." });
  }

  try {
    // Consulta para obtener la contraseña actual del usuario
    const [usuario] = await pool.query(
      "SELECT password FROM tblusuarios WHERE idUsuarios = ?",
      [idUsuario]
    );

    if (usuario.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    const hashedPassword = usuario[0].password;

    // Verificar la contraseña con Argon2
    const validPassword = await argon2.verify(hashedPassword, currentPassword);

    if (!validPassword) {
      return res
        .status(401)
        .json({ valid: false, message: "La contraseña actual es incorrecta." });
    }

    return res
      .status(200)
      .json({ valid: true, message: "La contraseña actual es correcta." });
  } catch (error) {
    console.error("Error al verificar la contraseña:", error);
    return res.status(500).json({ message: "Error interno del servidor." });
  }
});

//Cambiar contraseña y  guradarlo en el historial
usuarioRouter.post("/change-password", csrfProtection, async (req, res) => {
  const { idUsuario, newPassword } = req.body;
  console.log("Ide datos usairo", idUsuario, newPassword);
  const token = req.cookies.sesionToken;

  if (!idUsuario || !newPassword) {
    return res
      .status(400)
      .json({ message: "ID de usuario o nueva contraseña no proporcionados." });
  }

  try {
    const now = new Date();
    const mes = now.getMonth() + 1;
    const anio = now.getFullYear();
    const [cambiosMes] = await pool.query(
      `SELECT COUNT(*) AS cambios 
         FROM tblcambioPass
        WHERE idUsuario = ?
          AND MONTH(fecha) = ?
          AND YEAR(fecha) = ?`,
      [idUsuario, mes, anio]
    );
    console.log("Datos obtenidos de cabio pass mes", cambiosMes);
    if (cambiosMes[0].cambios >= 20) {
      return res.status(400).json({
        message:
          "Has alcanzado el límite de cambios de contraseña para este mes.",
      });
    }

    const [historico] = await pool.query(
      "SELECT password FROM tblhistorialpass WHERE idUsuarios = ? ORDER BY created_at DESC",
      [idUsuario]
    );
    console.log(
      "History",
      [historico],
      "Este es la nueva contraseña ",
      newPassword
    );

    if (!historico || historico.length === 0) {
      console.log(
        "No hay historial de contraseñas, se procederá a guardar la nueva contraseña."
      );
    } else {
      for (let pass of historico) {
        const isMatch = await argon2.verify(pass.password, newPassword);
        console.log(isMatch);

        if (isMatch) {
          return res.status(400).json({
            usedBefore: true,
            message: "La contraseña ya ha sido utilizada anteriormente.",
          });
        }
      }
    }

    const hashedPassword = await argon2.hash(newPassword);

    await pool.query(
      "UPDATE tblusuarios SET  password= ? WHERE idUsuarios = ?",
      [hashedPassword, idUsuario]
    );
    const fechaActual = obtenerFechaMexico();

    await pool.query(
      "INSERT INTO tblhistorialpass (idUsuarios, password, created_at) VALUES (?, ?, ?)",
      [idUsuario, hashedPassword, fechaActual]
    );

    const [updatedHistorial] = await pool.query(
      "SELECT * FROM tblhistorialpass WHERE idUsuarios = ? ORDER BY created_at DESC",
      [idUsuario]
    );

    if (updatedHistorial.length > 3) {
      const oldestPasswordId =
        updatedHistorial[updatedHistorial.length - 1].idhistorialpass;
      await pool.query(
        "DELETE FROM tblhistorialpass WHERE idhistorialpass = ?",
        [oldestPasswordId]
      );
    }

    await pool.query(
      "INSERT INTO tblcambioPass (idUsuario, fecha) VALUES (?, ?)",
      [idUsuario, fechaActual]
    );

    if (token) {
      await pool.query(
        "UPDATE tblsesiones SET horaFin =? WHERE idUsuarios = ? AND horaFin IS NULL AND cookie !=?",
        [fechaActual, idUsuario, token]
      );
    } else {
      await pool.query(
        "UPDATE tblsesiones SET horaFin =? WHERE idUsuarios = ? AND horaFin IS NULL",
        [fechaActual, idUsuario]
      );
    }

    return res.status(200).json({
      success: true,
      message:
        "Contraseña cambiada correctamente. Todas las sesiones han sido cerradas.",
    });
  } catch (error) {
    console.error("Error al cambiar la contraseña:", error);
    return res.status(500).json({ message: "Error interno del servidor." });
  }
});

//Verifcar el el usaurio solo pueda cambiatr su correo 5 veces * semana
usuarioRouter.get("/vecesCambioPass",verifyToken, async (req, res) => {
  try {
    const { idUsuario } = req.query;

    if (!idUsuario) {
      return res.status(400).json({ message: "ID de usuario requerido." });
    }

    const fechaActual = new Date();
    const mes = fechaActual.getMonth() + 1;
    const anio = fechaActual.getFullYear();
    console.log("Año y mes", mes, anio);

    const [cambiosMes] = await pool.query(
      `SELECT COUNT(*) AS cambios 
       FROM tblcambioPass
       WHERE idUsuario = ? 
       AND MONTH(fecha) = ? 
       AND YEAR(fecha) = ?`,
      [idUsuario, mes, anio]
    );

    console.log("Cambios paswword", cambiosMes);
    const totalCambios = cambiosMes[0].cambios;
    console.log("CAMBIOS TOTAL DE PASSWOR", totalCambios);

    return res.status(200).json({
      idUsuario,
      cambiosRealizados: totalCambios,
      limitePermitido: 20,
      puedeCambiar: totalCambios < 20,
      message:
        totalCambios >= 20
          ? "Has alcanzado el límite de cambios de contraseña este mes."
          : "Aún puedes cambiar tu contraseña.",
    });
  } catch (error) {
    console.error("Error al obtener cambios de contraseña:", error);
    return res.status(500).json({ message: "Error interno del servidor." });
  }
});

usuarioRouter.get("/lista",verifyToken, async (req, res, next) => {
  try {
    const [usuarios] = await pool.query(`
 SELECT 
      u.idUsuarios,
      u.correo,
      u.nombre,
      u.apellidoP,
      u.apellidoM,
      u.rol,
      (SELECT COUNT(*) FROM tblipbloqueados WHERE idUsuarios = u.idUsuarios) AS veces_bloqueado,
      (SELECT COUNT(*) FROM tblhistorialpass WHERE idUsuarios = u.idUsuarios) AS cambios_contrasena,
      (SELECT COUNT(*) FROM tblsesiones WHERE idUsuarios = u.idUsuarios) AS veces_sesion
    FROM 
      tblusuarios u
    `);
    res.json(usuarios);
  } catch (error) {
    console.error("Error al obtener la lista de usuarios:", error);
    res.status(500).json({ message: "Error al obtener la lista de usuarios." });
  }
});

usuarioRouter.get("/:idUsuario/sesiones",verifyToken, async (req, res, next) => {
  const { idUsuario } = req.params;
  try {
    const [sesiones] = await pool.query(
      `
       
      SELECT 
    idSesion,
    idUsuarios,
    horaInicio,
    horaFin,
    direccionIP,
    tipoDispositivo
FROM tblsesiones
WHERE idUsuarios = ?
ORDER BY horaInicio DESC;

      
    `,
      [idUsuario]
    );

    res.json(sesiones);
  } catch (error) {
    console.error("Error al obtener las sesiones del usuario:", error);
    res
      .status(500)
      .json({ message: "Error al obtener las sesiones del usuario." });
  }
});

//TOTAL DE USARIOS

usuarioRouter.get("/totalUsuarios", verifyToken, async (req, res, next) => {
  try {
    const [usuarios] = await pool.query(`
      SELECT
  (SELECT COUNT(*) FROM tblusuarios) AS totalUsuarios,

  (SELECT COUNT(DISTINCT p.idPedido)
   FROM tblpedidos p
   WHERE LOWER(p.estadoActual) IN (
     'procesando',
     'confirmado',
     'enviando',
     'recogiendo',
     'en alquiler',
     'devuelto',
     'incompleto',
     'incidente'
   )
  ) AS totalRentasActivas,

  (SELECT COALESCE(SUM(pg.monto), 0)
   FROM tblpagos pg
   WHERE pg.estadoPago = 'completado'
   AND MONTH(pg.fechaPago) = MONTH(CURRENT_DATE())
   AND YEAR(pg.fechaPago) = YEAR(CURRENT_DATE())
  ) AS ingresosMes,

  (SELECT COUNT(*)
   FROM tblpedidos p
   WHERE LOWER(p.estadoActual) = 'finalizado'
  ) AS totalPedidosFinalizados;

    `);

    res.json(usuarios);
  } catch (error) {
    console.error("Error al obtener total de usarios:", error);
    res.status(500).json({ message: "Error al obtener total de usarios." });
  }
});

//CAmbiar el rol de usuarios
usuarioRouter.put('/:userId/rol', csrfProtection, verifyToken, async (req, res) => {
  const { userId } = req.params;
  const { rol } = req.body;
  const rolesValidos = ['administrador', 'cliente', 'repartidor'];

  if (!rolesValidos.includes(rol)) {
    return res.status(400).json({ message: 'Rol inválido.' });
  }

  if (req.user.id === Number(userId)) {
    return res.status(403).json({ message: 'No puedes cambiar tu propio rol.' });
  }

  try {
    if (rol === 'repartidor') {
      const [rows] = await pool.query(
        'SELECT idRepartidor, activo FROM tblrepartidores WHERE idUsuario = ?',
        [userId]
      );

      if (rows.length === 0) {
        
        await pool.query(
          'INSERT INTO tblrepartidores (idUsuario, activo) VALUES (?, 1)',
          [userId]
        );
      } else if (rows[0].activo === 0) {
      
        await pool.query(
          `UPDATE tblrepartidores
             SET activo = 1,
                 fechaAlta = CURRENT_TIMESTAMP,
                 fechaBaja = NULL
           WHERE idRepartidor = ?`,
          [rows[0].idRepartidor]
        );
      }

      const [result] = await pool.query(
        'UPDATE tblusuarios SET rol = ? WHERE idUsuarios = ?',
        [rol, userId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Usuario no encontrado.' });
      }

      return res.json({ message: 'Usuario ahora es repartidor activo.' });
    }

    const [rows] = await pool.query(
      'SELECT idRepartidor, activo FROM tblrepartidores WHERE idUsuario = ?',
      [userId]
    );
    if (rows.length > 0 && rows[0].activo === 1) {
      
      return res.status(400).json({
        message:
          'No se puede cambiar el rol: el usuario está activo como repartidor hasta que se desactive.',
      });
    }

    const [result] = await pool.query(
      'UPDATE tblusuarios SET rol = ? WHERE idUsuarios = ?',
      [rol, userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }

 
    if (rows.length > 0 && rows[0].activo === 0) {
      return res.json({ message: 'Repartidor dado de baja: ahora es ' + rol + '.' });
    }

    return res.json({ message: 'Rol actualizado correctamente.' });
  } catch (error) {
    console.error('Error al actualizar rol:', error);
    return res.status(500).json({ message: 'Error interno al actualizar el rol.' });
  }
});



//=========================================CRONS-JOBS=================================================
async function verificarYLimpiarNoClientes() {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [noClientes] = await connection.query(`
      SELECT DISTINCT nc.idNoClientes
FROM tblnoclientes nc
INNER JOIN tblpedidos p ON nc.idNoClientes = p.idNoClientes
WHERE p.estadoActual IN ('Finalizado', 'Cancelado')
  AND p.fechaRegistro < DATE_SUB(NOW(), INTERVAL 1 MONTH)
  AND nc.idUsuario IS NULL;

    `);

    if (noClientes.length === 0) {
      console.log("No hay no clientes para eliminar.");
      return;
    }

    const idsNoClientes = noClientes.map((nc) => nc.idNoClientes);

    await connection.query(
      `
      DELETE p, d, nc
      FROM tblpedidos p
      JOIN tbldireccioncliente d ON p.idNoClientes = d.idNoClientes
      JOIN tblnoclientes nc ON p.idNoClientes = nc.idNoClientes
      WHERE p.idNoClientes IN (?);
    `,
      [idsNoClientes]
    );

    console.log(`Eliminados ${idsNoClientes.length} no clientes.`);
    await connection.commit();
  } catch (error) {
    console.error("Error en la verificación y limpieza de no clientes:", error);
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Error al hacer rollback:", rollbackError);
      }
    }
  } finally {
    if (connection) connection.release();
  }
}

cron.schedule(
  "0 0 * * *",
  async () => {
    console.log("Ejecutando verificación y limpieza de no clientes...");
    await verificarYLimpiarNoClientes();
    console.log("Verificación y limpieza completada.");
  },
  {
    timezone: "America/Mexico_City",
  }
);

module.exports = {usuarioRouter,verifyToken, obtenerFechaMexico};
