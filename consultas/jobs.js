const express = require("express");
const { pool } = require("../connectBd");
const { csrfProtection } = require("../config/csrf");
const { getIO } = require("../config/socket");
const moment = require("moment");

const { obtenerFechaMexico } = require("./clsUsuarios")

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


routerJobs.post('/trigger-abandoned-cart', veryfyCronSecrent, async (req, res) => {
    
    console.log('--- 🤖 INICIANDO JOB: Carritos Abandonados con Bajo Stock ---');
    
    let connection;
    try {
        connection = await pool.getConnection();

      
        const STOCK_BAJO = 20; 
        const TIEMPO_ABANDONADO = 12; 

        const query = `
                SELECT
                c.idUsuario,
              
                GROUP_CONCAT(DISTINCT p.nombre SEPARATOR ', ') AS productosConBajoStock
            FROM
                tblcarrito c
            JOIN
                tblinventario i ON c.idProductoColor = i.idProductoColor
            JOIN
                tblproductoscolores pc ON c.idProductoColor = pc.idProductoColores
            JOIN
                tblproductos p ON pc.idProducto = p.idProducto
            WHERE
               
                c.fechaActualizacion < NOW() - INTERVAL ? HOUR
            AND
               
                i.stock <= ?
            AND
              
                c.idUsuario IN (SELECT DISTINCT idUsuarios FROM tblsuscripciones WHERE idUsuarios IS NOT NULL)
            GROUP BY
                c.idUsuario;

        `;
        
        const [candidatos] = await connection.query(query, [TIEMPO_ABANDONADO, STOCK_BAJO]);

        if (candidatos.length === 0) {
            console.log('[Job] No se encontraron carritos abandonados con bajo stock.');
            return res.status(200).json({ success: true, message: "No hay usuarios para notificar." });
        }

        console.log(`[Job] ${candidatos.length} usuarios encontrados para notificar.`);

        
        for (const usuario of candidatos) {
            
          
            let nombreProducto = usuario.productosConBajoStock;
            if (nombreProducto.length > 50) {
                nombreProducto = nombreProducto.substring(0, 50) + "...";
            }

            const payload = JSON.stringify({
                title: "¡No te quedes sin tu producto! 🛒",
                body: `¡Quedan pocas unidades de ${nombreProducto} en tu carrito! Completa tu pedido antes de que se agoten.`,
                url: "/cliente/carrito" 
            });

            await enviarNotificacionPush(usuario.idUsuario, payload);
        }

        console.log('--- ✅ JOB COMPLETADO: Notificaciones de Carrito Abandonado ---');
        res.status(200).json({ success: true, message: `Notificaciones enviadas a ${candidatos.length} usuarios.` });
        
    } catch (error) {
        console.error("❌ Error en el job de carritos abandonados:", error);
        res.status(500).json({ success: false, message: "Falló la tarea programada.", error: error.message });
    } finally {
        if (connection) connection.release();
    }
});


routerJobs.post('/trigger-inactivity-check', veryfyCronSecrent, async (req, res) => {
    
    console.log('--- 🤖 INICIANDO JOB: Revisión de Inactividad de Puntos ---');
    
    let connection;
    try {
        connection = await pool.getConnection();

        
        const [usuarios] = await connection.query(`
            SELECT 
                idUsuario,
                SUM(puntos) AS puntosDisponibles,
                MAX(fechaMovimiento) AS ultimaActividad,
                DATEDIFF(NOW(), MAX(fechaMovimiento)) AS diasInactivo
            FROM tblPuntos
            GROUP BY idUsuario
            HAVING puntosDisponibles > 0 OR diasInactivo > 0; 
        `);

        console.log(`[Job Inactividad] Revisando ${usuarios.length} usuarios...`);
        let notificacionesEnviadas = 0;

        for (const usuario of usuarios) {
            const { idUsuario, puntosDisponibles, diasInactivo } = usuario;
            let payload = null;
            let puntosAReducir = 0;
            let nuevoTipoMovimiento = null;


            if (diasInactivo === 15) {
                payload = {
                    title: "¡Te estamos esperando! 🎉",
                    body: "Vimos que no has vuelto. ¡Regresa y sigue acumulando Puntos Fiesta!",
                    url: "/cliente/nivel/logros"
                };
            }
            else if (diasInactivo === 30) { 
                payload = {
                    title: "¡Regresa con nosotros!",
                    body: "Hace tiempo que no te vemos. ¡Tus beneficios y puntos te esperan!",
                    url: "/cliente/nivel/logros"
                };
            }

      
            else if (diasInactivo === 50) { 
                payload = {
                    title: "Aviso de Puntos Fiesta",
                    body: "Detectamos inactividad en tu cuenta. Para conservar tus puntos, realiza una renta o canjea tus puntos pronto.",
                    url: "/cliente/nivel/logros"
                };
            }
            else if (diasInactivo === 58) { 
                payload = {
                    title: "⚠️ Último Aviso: Tus Puntos Fiesta",
                    body: "Tu saldo de puntos disminuirá en 2 días debido a inactividad. ¡Realiza un pedido o canjea ahora!",
                    url: "/cliente/nivel/logros"
                };
            }
            else if (diasInactivo === 60) { 
                puntosAReducir = Math.floor(puntosDisponibles * 0.20);
                nuevoTipoMovimiento = "Reducción 20% (Inactividad 2 meses)";
                payload = {
                    title: "Aviso: Reducción de Puntos Fiesta",
                    body: `Se aplicó una reducción de ${puntosAReducir} puntos (-20%) a tu saldo por inactividad.`,
                    url: "/cliente/nivel/logros"
                };
            }
            else if (diasInactivo > 60 && (diasInactivo % 30 === 0)) {
                puntosAReducir = Math.floor(puntosDisponibles * 0.20);
                nuevoTipoMovimiento = "Reducción 20% (Inactividad mensual)";
                payload = {
                    title: "Aviso: Reducción Mensual de Puntos",
                    body: `Tu saldo ha sido reducido en ${puntosAReducir} puntos (-20%) por inactividad continua.`,
                    url: "/cliente/nivel/logros"
                };
            }

       
            if (puntosAReducir > 0 && puntosDisponibles > 0) {

                if ((puntosDisponibles - puntosAReducir) < 0) {
                    puntosAReducir = puntosDisponibles; 
                }
                
                if (puntosAReducir > 0) {
                    await connection.query(
                        "INSERT INTO tblPuntos (idUsuario, tipoMovimiento, puntos, fechaMovimiento) VALUES (?, ?, ?, NOW())",
                        [idUsuario, nuevoTipoMovimiento, -Math.abs(puntosAReducir)]
                    );
                    console.log(`[Job] Usuario ${idUsuario}: Reducción de ${puntosAReducir} puntos.`);
                }
            }

         
            if (payload) {
                await enviarNotificacionPush(idUsuario, JSON.stringify(payload));
                notificacionesEnviadas++;
            }
        } 

        
        const [usuariosPuntosCero] = await connection.query(`
            SELECT idUsuario, DATEDIFF(NOW(), MAX(fechaMovimiento)) AS diasInactivo
            FROM tblPuntos
            GROUP BY idUsuario
            HAVING SUM(puntos) <= 0 AND diasInactivo > 60 AND (DATEDIFF(NOW(), MAX(fechaMovimiento)) % 30 = 0); 
        `);

        for (const usuario of usuariosPuntosCero) {
             const payload = {
                title: "¡Te extrañamos en la fiesta!",
                body: "Vuelve y descubre nuevas recompensas. ¡Empieza a ganar Puntos Fiesta de nuevo!",
                url: "/"
            };
            await enviarNotificacionPush(usuario.idUsuario, JSON.stringify(payload));
            notificacionesEnviadas++;
        }

        console.log(`--- ✅ JOB COMPLETADO: ${notificacionesEnviadas} notificaciones enviadas ---`);
        res.status(200).json({ success: true, message: `Job de inactividad completado. ${notificacionesEnviadas} usuarios notificados.` });
        
    } catch (error) {
        console.error("❌ Error en el job de inactividad:", error);
        res.status(500).json({ success: false, message: "Falló la tarea programada.", error: error.message });
    } finally {
        if (connection) connection.release();
    }
});



module.exports = routerJobs;
