const express = require("express");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const crypto = require("crypto");
const { csrfProtection } = require("../config/csrf");
const moment = require("moment");
const otplib = require("otplib");
const qrcode = require("qrcode");


const { pool } = require("../connectBd");

const usuarioRouter = express.Router();
usuarioRouter.use(express.json());
usuarioRouter.use(cookieParser());

// Configurar winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

//Variables para el ip
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TIME = 10 * 60 * 1000;
const TOKEN_EXPIRATION_TIME = 30 * 60 * 1000;
if (!process.env.SECRET_KEY) {
  throw new Error("La variable de entorno SECRET_KEY no está definida.");
}
const SECRET_KEY = process.env.SECRET_KEY.padEnd(32, " ");

//========================COOKIES================================================
//Encriptamos el clientId
function encryptClientId(clientId) {
  const IV_LENGTH = 16;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(SECRET_KEY, "utf-8"),
    iv
  );
  let encrypted = cipher.update(clientId, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

//DEscribtar el clienteId
function decryptClientId(encrypted) {
  const [iv, encryptedText] = encrypted.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    SECRET_KEY,
    Buffer.from(iv, "hex")
  );
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

//Creamos un identificador unico para el cliente
function getOrCreateClientId(req, res) {
  let clientId = req.cookies.clientId;
  if (!clientId) {
    clientId = uuidv4();
    const encryptedClientId = encryptClientId(clientId);
    res.cookie("clientId", encryptedClientId, {
      maxAge: 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "None",
    });
  } else {
    clientId = decryptClientId(clientId);
  }
  return clientId;
}


//Funcion  para obtener la fecha actual
function obtenerFechaMexico() {
  const fechaCreacion = new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" });
  return fechaCreacion.replace(" ", "T").replace(",", "");
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

    
    const capitalizeFirstLetter = (str) => {
      return str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : "";
    };
    const nombreFormateado = capitalizeFirstLetter(nombre);
    const apellidoPFormateado = capitalizeFirstLetter(apellidoP);
    const apellidoMFormateado = capitalizeFirstLetter(apellidoM);


    const hashedPassword = await argon2.hash(password);

 
    const fechaCreacion = new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" });

    const query = `
      INSERT INTO tblusuarios 
      (nombre, apellidoP, apellidoM, correo, telefono, password, rol, estado, multifaltor, fechaCreacion) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await connection.query(query, [
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

   

    // Manejo de `insertId` dependiendo de la estructura de `result`
    const insertId = result.insertId;
    console.log("Obtenemos el insertId del usuario", insertId);

    if (!insertId) {
      await connection.rollback();
      return res.status(500).json({ message: "Error al registrar usuario" });
    }

    const queryPerfil = `
      INSERT INTO tblperfilusuarios (idUsuarios, fotoPerfil)
      VALUES (?, NULL)
    `;
    await connection.query(queryPerfil, [insertId]);

    await connection.commit();

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
    // Extraer email, contraseña y token MFA (si se incluye)
    const {
      email,
      contrasena,
      tokenMFA,
      deviceType,
      captchaToke,
      ip,
    } = req.body;

    const clientTimestamp=obtenerFechaMexico()

    if (!email || !contrasena) {
      return res
        .status(400)
        .json({ message: "Email y contraseña son obligatorios." });
    }
    
    const cookiesId = getOrCreateClientId(req, res);

    // Verificar si la conexión a la base de datos está disponible
    if (!pool) {
      throw new Error("La conexión a la base de datos no está disponible.");
    }

    // Buscar al usuario por correo
    const query = "SELECT * FROM tblusuarios WHERE correo = ?";
    const [result] = await pool.query(query, [email]);     
    if (!Array.isArray(result) || result.length === 0) { 
      console.log("Credenciales Incorrectas");
      return res.status(401).json({ message: "Credenciales Incorrectas" });
    }
    
    const usuario = result[0]; 
   

    
    //===================================================================================================
  
    
    // Verificar si el usuario está bloqueado
    const bloqueoQuery = "SELECT * FROM tblipbloqueados WHERE idUsuarios = ?";
    const [bloqueos] = await pool.query(bloqueoQuery, [usuario.idUsuarios]);


    if (bloqueos.length > 0) {
      const bloqueo = bloqueos[0];
      const ahora = new Date();

      console.log("ahora", ahora)
      const lockUntil = bloqueo.lock_until
        ? new Date(bloqueo.lock_until)
        : null;

      // **
      if (bloqueo.bloqueado === 1) {
        console.log("Usuario bloqueado por el administrador.");
        return res.status(403).json({
          message: "Cuenta bloqueada por el administrador.",
        });
      }
      if (lockUntil && lockUntil <= ahora) {
        console.log(
          "El tiempo de bloqueo ha expirado. Desbloqueando usuario..."
        );
        const desbloqueoQuery = `
      UPDATE tblipbloqueados 
      SET intentos = 0, lock_until = NULL 
      WHERE idUsuarios = ?`;
        await pool.query(desbloqueoQuery, [usuario.idUsuarios]);
        bloqueo.intentos = 0; 
        bloqueo.lock_until = null;
        console.log("Usuario desbloqueado correctamente.");
      }

     
      if (bloqueo.intentos >= MAX_FAILED_ATTEMPTS) {
    
        if (!lockUntil) {
          const lockTime = new Date(ahora.getTime() + LOCK_TIME);
          const actualizarLockQuery = `
        UPDATE tblipbloqueados 
        SET lock_until = ? 
        WHERE idUsuarios = ?`;
          await pool.query(actualizarLockQuery, [
            lockTime,
            usuario.idUsuarios,
          ]);
          bloqueo.lock_until = lockTime;
        }

        // **3.2. Calcular el tiempo restante de bloqueo**
        const tiempoRestanteSegundos = Math.ceil((bloqueo.lock_until - ahora) / 1000);

               console.log("Tiempo en segundos",  Math.ceil((bloqueo.lock_until - ahora) / 1000))
        let tiempoRestanteMensaje;
        if (tiempoRestanteSegundos >= 60) {
          const minutos = Math.floor(tiempoRestanteSegundos / 60);
          const segundos = tiempoRestanteSegundos % 60;
          tiempoRestanteMensaje = `${minutos} minuto${
            minutos !== 1 ? "s" : ""
          }${
            segundos > 0
              ? ` y ${segundos} segundo${segundos !== 1 ? "s" : ""}`
              : ""
          }`;
        } else {
          tiempoRestanteMensaje = `${tiempoRestanteSegundos} segundo${
            tiempoRestanteSegundos !== 1 ? "s" : ""
          }`;
        }

        console.log(
          `Usuario bloqueado temporalmente por 10 minutos .` 
        );
        return res.status(403).json({
          message: `Usuario bloqueado temporalmente. Inténtalo de nuevo en ${tiempoRestanteMensaje}.`,
          tiempoRestante: tiempoRestanteSegundos,
        });
      }
    }

    //================================================================================
    // Comparar la contraseña con la base de datos
    const validPassword = await argon2.verify(usuario.password, contrasena);

    if (!validPassword) {
      await handleFailedAttempt(ip , usuario.idUsuarios, pool);

      return res.status(401).json({ message: "Credenciales Incorrectos" });
    }
    //==============================================================MFA ATIVADO=====================
    console.log("Este es e multifactor",usuario.multifaltor);

    
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

      console.log(isValidMFA);

      if (!isValidMFA) {
        return res.status(400).json({ message: "Código MFA incorrecto." });
      }
    }
  // Generar token JWT
    const token = jwt.sign(
      { id: usuario.idUsuarios, nombre: usuario.nombre, rol: usuario.rol},
      SECRET_KEY,
      { expiresIn: "30m" }
    );

    // Crear la cookie de sesión
    res.cookie("sesionToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "None",
      maxAge: TOKEN_EXPIRATION_TIME,
    });

    // Insertar la sesión en tblsesiones
    try {
      const sessionQuery = `
    INSERT INTO tblsesiones (idUsuarios, tokenSesion, horaInicio, direccionIP, tipoDispositivo, cookie, horaFin)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON DUPLICATE KEY UPDATE
      idUsuarios = VALUES(idUsuarios),
      horaInicio = VALUES(horaInicio),
      direccionIP = VALUES(direccionIP),
      tipoDispositivo = VALUES(tipoDispositivo),
      cookie = VALUES(cookie),
      horaFin = NULL
  `;
      await pool.query(sessionQuery, [
        usuario.idUsuarios,
        cookiesId,
        clientTimestamp,
        ip,
        deviceType,
        token,
      ]);
      console.log("Sesión insertada en tblsesiones");
    } catch (insertError) {
      console.error("Error al insertar la sesión en tblsesiones:", insertError);
      next(error);
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

//================================Manejo de intentos fallidos de login=======================================
async function handleFailedAttempt(ip, idUsuarios, pool) {
  // Obtener la fecha y hora actual
  const currentDate = new Date();
  const fechaActual = currentDate.toISOString().split("T")[0];
  const horaActual = currentDate.toTimeString().split(" ")[0];

  // Consultar si ya existe un bloqueo para este usuario
  const [result] = await pool.query(
    "SELECT * FROM tblipbloqueados WHERE idUsuarios = ?",
    [idUsuarios]
  );

  console.log("Bloqueado23", result)

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
    // Si ya existe un registro, actualizamos los intentos fallidos
    const bloqueo = result[0];
    const newAttempts = bloqueo.intentos + 1;
    const newIntentosReales = bloqueo.intentosReales + 1;

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
}

///==========================================================================================================================================================================================
//====================Consulta de perfil de usuario========================================================0
//Middleware para validar token
const verifyToken = async (req, res, next) => {
  const token = req.cookies.sesionToken;


  if (!token) {
    return res.status(403).json({ message: "No tienes token de acceso." });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    console.log("Token desifrado", decoded)
    const now = Math.floor(Date.now() / 1000);

    // Verificar si la sesión existe y está activa
    const sessionQuery = `
  SELECT * FROM tblsesiones WHERE idUsuarios = ? AND cookie = ? AND horaFin IS NULL
`;
    const [sessions] = await pool.query(sessionQuery, [decoded.id, token]);
    console.log("Seson obtenido", sessions)

    if (sessions.length === 0) {
      // Sesión no encontrada o finalizada
      return res.status(401).json({
        message:
          "Sesión inválida o expirada. Por favor, inicia sesión nuevamente.",
      });
    }
 

    console.log("decoded", decoded.exp)
    // Si el token expira en menos de 2 minutos, renovamos el token
    const timeRemaining = decoded.exp - now;
    if (timeRemaining < 2 * 60) {
      const newToken = jwt.sign(
        { id: decoded.id, nombre: decoded.nombre, rol: decoded.rol },
        SECRET_KEY,
        { expiresIn: "30m" }
      );
      res.cookie("sesionToken", newToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "None",
        maxAge: TOKEN_EXPIRATION_TIME,
      });
      const updateSessionQuery = `
      UPDATE tblsesiones
      SET tokenSesion = ?
      WHERE idUsuarios = ? AND cookie = ? AND horaFin IS NULL
    `;
      await pool.query(updateSessionQuery, [newToken, decoded.id, token]);
      token = newToken;

      console.log("Token renovado exitosamente.");
    } else {
      console.log(`Tiempo restante para el token: ${timeRemaining} segundos.`);
    } 

    req.user = decoded;
    next();
  } catch (error) {
    // Capturar errores relacionados con la verificación del token
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "El token ha expirado. Por favor, inicia sesión nuevamente.",
      });
    } else if (error.name === "JsonWebTokenError") {
      return res
        .status(400)
        .json({ message: "El token proporcionado no es válido." });
    } else {
      return res.status(500).json({ message: "Error interno del servido br." });
    }
  }
};

// Ruta protegida
usuarioRouter.get("/perfil", verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    //Hacemos la consulat de la pool
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
        multifaltor:usuario.multifaltor,
        direccion: usuario.direccion,
        fechaNacimiento: usuario.fechaNacimiento,
        fotoPerfil: usuario.fotoPerfil,
        fechaActualizacionF: usuario.fechaActualizacionF,
        fechaCreacion: usuario.fechaCreacion
      },
    });
  } catch (error) {
    console.error("Error al obtener el perfil del usuario:", error);
    res
      .status(500)
      .json({ message: "Error al obtener el perfil del usuario." });
  }
});

//CCERRAMOS SESION
usuarioRouter.post("/Delete/login",csrfProtection, async (req, res) => {
  const token = req.cookies.sesionToken;
  if (!token) {
    return res.status(400).json({ message: "No hay sesión activa." });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    // Actualizar la horaFin en tblsesiones
    const query = `
      UPDATE tblsesiones
      SET horaFin = NOW()
      WHERE idUsuarios = ? AND cookie = ? AND horaFin IS NULL
    `;
    await pool.query(query, [userId, token]);

    res.clearCookie("sesionToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "None",
    });
    console.log("sesion cerrada correctamente")
    res.json({ message: "Sesión cerrada correctamente." });
  } catch (error) {
    console.error("Error al cerrar la sesión:", error);
    res.status(500).json({ message: "Error al cerrar la sesión." });
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
usuarioRouter.patch("/perfil/:id/foto", async (req, res) => {
  const userId = req.params.id;
  console.log("perfil", userId)
  const { fotoPerfil } = req.body; 

  console.log("perfil", fotoPerfil)
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
      new Date().toISOString().slice(0, 19).replace('T', ' '), 
      userId,
    ]);

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

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
usuarioRouter.patch("/perfil/:id/:field", csrfProtection, async (req, res) => {
  let { id, field } = req.params;
  let { value } = req.body;

  console.log("Datos recibidos:", { id, field, value });

  // Lista de campos permitidos
  const allowedFields = ["nombre", "apellidoP", "apellidoM", "telefono", "fechaNacimiento"];

  if (!allowedFields.includes(field)) {
    return res.status(400).json({ message: "Campo no permitido para actualización." });
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
      console.log("Resulltado de fecha n", result)
    
      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(404).json({ message: "Perfil de usuario no encontrado." });
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
    res.json({ message: `${field} actualizado correctamente`, updatedField: value });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`Error al actualizar ${field}:`, error);
    res.status(500).json({ message: `Error al actualizar ${field}.` });
  } finally {
    if (connection) connection.release();
  }
});


usuarioRouter.post("/sesiones", csrfProtection, async (req, res) => {
  const { userId } = req.body;
  console.log("Id de sesiones enviado ", userId)

  if (!userId) {
    return res.status(400).json({ message: "El userId es necesario." });
  }

  try {
    if (!pool) {
      return res.status(500).json({ message: "Error de conexión con la base de datos." });
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
      return res.json([]);
    }
    const currentToken = req.cookies.sesionToken;

    console.log("Este es el tokn 123", currentToken)


    const sessionsWithCurrentFlag = sessions.map((session) => ({
      ...session,
      isCurrent: session.tokenSesion === currentToken,
    }));

    console.log("sesion de token obtenido ",  sessionsWithCurrentFlag)




    res.json(sessionsWithCurrentFlag);
  } catch (error) {
    console.error("Error al obtener las sesiones del usuario:", error);
    res
      .status(500)
      .json({ message: "Error al obtener las sesiones del usuario." });
  }
});



module.exports = usuarioRouter;
