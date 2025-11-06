const express = require("express");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");
const { getIO } = require("../config/socket");
const moment = require("moment");

const { obtenerFechaMexico } = require("./clsUsuarios")
const Stripe = require('stripe');
const apiKey = process.env.STRIPE_SECRET_KEY || 'sk_test_DUMMY_KEY_FOR_JEST_123456789';
const stripe = Stripe(apiKey);
const axios = require("axios");
const router = require("../rutas");
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const { verifyToken } = require("./clsUsuarios");
const { verificarYAsignarLogros } =  require('../config/logicaLogros');
const { determinarNivel } = require('../config/logicaNiveles');
const webpush = require('web-push');

const routerJobs = express.Router();
routerJobs.use(express.json());



//Funcion de validacion
const veryfyCronSecrent = (req, res, next)=>{
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; 

        if (!token) {
            return res.status(401).json({ message: 'Acceso no autorizado (Sin token de Cron).' });
        }

      
        if (token === process.env.CRON_SECRET) {
            next();
        } else {
            return res.status(403).json({ message: 'Acceso denegado (Token de Cron inválido).' });
        }
    } catch (error) {
        res.status(401).json({ message: 'Error de autorización de Cron.' });
    }
}


async function enviarNotificacionPush(idUsuario, payloadJSON) {
    try {
        
        const [suscripciones] = await pool.query(
            "SELECT endpoint, p256dh, auth FROM tblsuscripciones WHERE idUsuarios = ?",
            [idUsuario]
        );

        if (suscripciones.length === 0) {
            console.log(`[Job] Usuario ${idUsuario} no tiene suscripciones activas.`);
            return;
        }

      
        for (const sub of suscripciones) {
            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth }
            };
            
           
            await webpush.sendNotification(pushSubscription, payloadJSON);
        }
        
        console.log(`[Job] Notificación enviada a ${suscripciones.length} dispositivos del Usuario ${idUsuario}.`);

    } catch (error) {
        console.error(`[Job] Error enviando Push a Usuario ${idUsuario}:`, error.message);
       
        if (error.statusCode === 410 || error.statusCode === 404) {
            
            await pool.query("DELETE FROM tblsuscripciones WHERE endpoint = ?", [error.endpoint]);
        }
    }
}


 routerJobs.post('/trigger-level-notifications', veryfyCronSecrent, async (req, res) => {  
    let connection;
    try {
        connection = await pool.getConnection();
        const PUNTOS_CERCANIA = 100; 
        const query = `
         WITH UserLevels AS (
                SELECT
                    idUsuarios,
                    PuntosReales,
                    nivel,
                    (CASE
                        WHEN PuntosReales < 500 THEN 500
                        WHEN PuntosReales < 2000 THEN 2000
                        WHEN PuntosReales < 5000 THEN 5000
                        ELSE NULL
                    END) AS PuntosSiguienteNivel,
                    (CASE
                        WHEN PuntosReales < 500 THEN 'Anfitrión'
                        WHEN PuntosReales < 2000 THEN 'Organizador Pro'
                        WHEN PuntosReales < 5000 THEN 'Embajador de Fiesta'
                        ELSE NULL
                    END) AS NombreSiguienteNivel,
                    (CASE
                        WHEN PuntosReales < 500 THEN '5% de descuento en todas las rentas'
                        WHEN PuntosReales < 2000 THEN '10% de descuento en todas las rentas. Prioridad en las rutas de entrega'
                        WHEN PuntosReales < 5000 THEN '12% de descuento en todas las rentas. Prioridad en las rutas de entrega. Envío gratuito sin mínimo de compra'
                        ELSE NULL
                    END) AS BeneficioSiguiente
                FROM tblNiveles
                WHERE idUsuarios IS NOT NULL
            ),
            Candidates AS (
                SELECT
                    *,
                    (PuntosSiguienteNivel - PuntosReales) AS PuntosFaltantes
                FROM UserLevels
                WHERE (PuntosSiguienteNivel - PuntosReales) BETWEEN 1 AND ?
            )
            SELECT * FROM Candidates;     
        `;
        
        const [candidatos] = await connection.query(query, [PUNTOS_CERCANIA]);

        if (candidatos.length === 0) {
            console.log('[Job] No se encontraron usuarios cerca de subir de nivel.');
            return res.status(200).json({ success: true, message: "No hay usuarios para notificar." });
        }

        console.log(`[Job] ${candidatos.length} usuarios encontrados para notificar.`);

       
        for (const usuario of candidatos) {
            
            const payload = JSON.stringify({
                title: "¡Estás a un paso de tu premio! 🏆",
                body: `¡Solo te faltan ${usuario.PuntosFaltantes} puntos para ser ${usuario.NombreSiguienteNivel} y desbloquear tu ${usuario.BeneficioSiguiente}!`,
                url: "/cliente/nivel/logros" 
            });

            await enviarNotificacionPush(usuario.idUsuarios, payload);
        }

        console.log('--- ✅ JOB COMPLETADO: Notificaciones de Nivel ---');
        res.status(200).json({ success: true, message: `Notificaciones enviadas a ${candidatos.length} usuarios.` });
        
    } catch (error) {
        console.error("❌ Error en el job de notificaciones de nivel:", error);
        res.status(500).json({ success: false, message: "Falló la tarea programada.", error: error.message });
    } finally {
        if (connection) connection.release();
    }
});




module.exports = routerJobs;
