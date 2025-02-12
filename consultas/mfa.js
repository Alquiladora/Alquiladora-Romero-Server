const express = require('express');
const otplib = require('otplib');
const qrcode = require('qrcode');
const { csrfProtection } = require("../config/csrf");
const { pool } = require("../connectBd");



const mfaRoute = express.Router();

otplib.authenticator.options = {
    window: 2, 
  };

// Habilitar MFA
mfaRoute.post('/verify-mfa',csrfProtection, async (req, res) => {
    try {
      const { userId, token } = req.body;
      console.log("estee es userid, token", userId,token)
  
      // Validación rápida de entrada
      if (!userId || !token) {
        return res.status(400).json({ message: 'Faltan datos requeridos: userId o token.' });
      }
  
      // Consulta de usuario
      const [usuarios] = await pool.query("SELECT multifaltor FROM tblusuarios WHERE idUsuarios = ?", [userId]);
      console.log("Usuarios encontrado", [usuarios]);
      if (usuarios.length === 0) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
  
      const { multifaltor } = usuarios[0];
      console.log("Alquiladora Romero", {multifaltor});
  
      // Verificación del token MFA
      const isValidMFA = otplib.authenticator.check(token, multifaltor);
      console.log("MisValidMFA", isValidMFA);
      
      if (isValidMFA) {
        return res.json({ message: 'Código MFA verificado correctamente.', user: usuarios[0] });
      } else {
        return res.status(400).json({ message: 'Código MFA incorrecto o vencido.' });
      }
    } catch (error) {
      console.error('Error al verificar MFA:', error);
      res.status(500).json({ message: 'Error al verificar MFA.' });
    }
  });
  
  

  mfaRoute.post('/enable-mfa', csrfProtection, async (req, res) => {
    try {
      const { userId } = req.body;
  
      // Verificar si el usuario existe
      const [usuarios] = await pool.query("SELECT * FROM tblusuarios WHERE idUsuarios = ?", [userId]);
      if (usuarios.length === 0) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
  
      const usuario = usuarios[0];
  
      // Generar la clave secreta para MFA
      const mfaSecret = otplib.authenticator.generateSecret();
      const accountName = usuario.nombre; 
      const issuer = 'Alquiladora Romero';
      const otpauthURL = otplib.authenticator.keyuri(accountName, issuer, mfaSecret);
      
      // Generar el código QR
      const qrCode = await qrcode.toDataURL(otpauthURL);
      
      // Guardar el MFA en la base de datos
      await pool.query("UPDATE tblusuarios SET multifaltor = ? WHERE idUsuarios = ?", [mfaSecret, usuario.idUsuarios]);
  
      // Establecer cookie de MFA
      res.cookie("mfaToken", "active", { httpOnly: true, secure: true, sameSite: 'Strict' });
  
      res.json({ message: 'MFA habilitado correctamente.', qrCode });
    } catch (error) {
      console.error('Error al habilitar MFA:', error);
      res.status(500).json({ message: 'Error al habilitar MFA.' });
    }
  });

  


// Deshabilitar MFA
mfaRoute.post('/disable-mfa',csrfProtection,  async (req, res) => {
  try {
    const { userId } = req.body;

    // Limpiar el campo de MFA en la base de datos
    await pool.query("UPDATE tblusuarios SET multifaltor = NULL WHERE idUsuarios = ?", [userId]);

    // Limpiar la cookie de MFA
    res.clearCookie("mfaToken");

    res.json({ message: 'MFA deshabilitado correctamente.' });
  } catch (error) {
    console.error('Error al deshabilitar MFA:', error);
    res.status(500).json({ message: 'Error al deshabilitar MFA.' });
  }
});

// Verificar MFA
mfaRoute.post('/verify-mfa',csrfProtection,  async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ message: 'Faltan datos requeridos: userId o token.' });
    }

    // Verificar si el usuario tiene MFA activado
    const [usuarios] = await pool.query("SELECT multifaltor FROM tblusuarios WHERE idUsuarios = ?", [userId]);
    if (usuarios.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }

    const { multifaltor } = usuarios[0];

    // Verificar el código MFA
    const isValidMFA = otplib.authenticator.check(token, multifaltor);
    if (isValidMFA) {
      return res.json({ message: 'Código MFA verificado correctamente.' });
    } else {
      return res.status(400).json({ message: 'Código MFA incorrecto.' });
    }
  } catch (error) {
    console.error('Error al verificar MFA:', error);
    res.status(500).json({ message: 'Error al verificar MFA.' });
  }
});

// Obtener estado de MFA
mfaRoute.get('/mfa-status/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
  
      // Verifica si el usuario tiene MFA activado
      const [usuarios] = await pool.query("SELECT multifaltor FROM tblusuarios WHERE idUsuarios = ?", [userId]);
  
      // Verifica si se encontró el usuario
      if (usuarios.length === 0) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
  
      // Verifica si el campo multifaltor no es null, vacío o inválido
      const mfaSecret = usuarios[0].multifaltor;
  
      // Solo considera activado si multifaltor es un valor no nulo ni vacío
      const mfaEnabled = mfaSecret !== null && mfaSecret.trim() !== '';
  
      // Devuelve el estado de MFA
      res.json({ mfaEnabled });
    } catch (error) {
      console.error('Error al obtener el estado de MFA:', error);
      res.status(500).json({ message: 'Error al obtener el estado de MFA.' });
    }
  });
  
module.exports = mfaRoute;
