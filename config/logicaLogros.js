const { obtenerFechaMexico } = require('../consultas/clsUsuarios');


const ID_ANFITRION_PRIMERA = 1;
const ID_CRITICO_CONFIANZA = 2;
const ID_CLIENTE_FRECUENTE = 3;
const ID_FIESTERO_TOTAL = 4;
const ID_PLANIFICADOR_EXPERTO = 5;
const ID_CLIENTE_VIP = 6;



async function verificarYAsignarLogros(evento, idUsuario, connection, datosExtra = {}) {
    try {
        switch (evento) {
            case 'PEDIDO_FINALIZADO':
                await _checkAnfitrionDePrimera(idUsuario, connection);
                await _checkClienteFrecuente(idUsuario, connection);
                await _checkPlanificadorExperto(idUsuario, connection);
                await _checkClienteVIP(idUsuario, connection);
                if (datosExtra.idPedido) {
                    await _checkFiesteroTotal(idUsuario, connection, datosExtra.idPedido);
                }
                break;

            case 'RESEÑA_CON_FOTO':
                await _checkCriticoDeConfianza(idUsuario, connection);
                break;
        }
    } catch (error) {
        console.error(`Error en logrosService para evento ${evento} y usuario ${idUsuario}:`, error);
        throw new Error(`Error al procesar logros: ${error.message}`);
    }
}


async function _checkClienteFrecuente(idUsuario, connection) {
    const yaLoTiene = await _tieneLogro(idUsuario, ID_CLIENTE_FRECUENTE, connection);
    if (yaLoTiene) return;
    const [rows] = await connection.query(
        `SELECT COUNT(idPedido) as total FROM tblpedidos WHERE idUsuarios = ? AND estadoActual = 'Finalizado'`,
        [idUsuario]
    );
    if (rows[0].total === 3) {
        await _otorgarLogro(idUsuario, ID_CLIENTE_FRECUENTE, connection);
    }
}

async function _checkAnfitrionDePrimera(idUsuario, connection) {
    const yaLoTiene = await _tieneLogro(idUsuario, ID_ANFITRION_PRIMERA, connection);
    if (yaLoTiene) return;
    const [rows] = await connection.query(
        `SELECT COUNT(idPedido) as total FROM tblpedidos WHERE idUsuarios = ? AND estadoActual= 'Finalizado'`,
        [idUsuario]
    );
    if (rows[0].total === 1) {
        await _otorgarLogro(idUsuario, ID_ANFITRION_PRIMERA, connection);
    }
}

async function _checkCriticoDeConfianza(idUsuario, connection) {
    const yaLoTiene = await _tieneLogro(idUsuario, ID_CRITICO_CONFIANZA, connection);
    if (yaLoTiene) return;
    await _otorgarLogro(idUsuario, ID_CRITICO_CONFIANZA, connection);
}

async function _checkPlanificadorExperto(idUsuario, connection) {
    const yaLoTiene = await _tieneLogro(idUsuario, ID_PLANIFICADOR_EXPERTO, connection);
    if (yaLoTiene) return;
    const [rows] = await connection.query(
        `SELECT COUNT(idPedido) as total FROM tblpedidos WHERE idUsuarios = ? AND estadoActual = 'Finalizado' AND FechaA >= DATE_SUB(NOW(), INTERVAL 365 DAY)`,
        [idUsuario]
    );
    if (rows[0].total >= 5) {
        await _otorgarLogro(idUsuario, ID_PLANIFICADOR_EXPERTO, connection);
    }
}

async function _checkClienteVIP(idUsuario, connection) {
    const yaLoTiene = await _tieneLogro(idUsuario, ID_CLIENTE_VIP, connection);
    if (yaLoTiene) return;
    const [rows] = await connection.query(
        `SELECT SUM(totalPagar) as gastoTotal FROM tblpedidos WHERE idUsuarios = ? AND estadoActual = 'Finalizado'`,
        [idUsuario]
    );
    if (rows[0].gastoTotal && rows[0].gastoTotal >= 30000) {
        await _otorgarLogro(idUsuario, ID_CLIENTE_VIP, connection);
    }
}

// --- 👇 FUNCIÓN CORREGIDA 👇 ---
async function _checkFiesteroTotal(idUsuario, connection, idPedido) {
    if (!idPedido) {
        console.warn("Skipping _checkFiesteroTotal: idPedido not provided.");
        return;
    }

    const yaLoTiene = await _tieneLogro(idUsuario, ID_FIESTERO_TOTAL, connection);
    if (yaLoTiene) return;

    const [rows] = await connection.query(
        `SELECT COUNT(DISTINCT c.idcategoria) as totalCategorias
         FROM tblpedidodetalles pd
         JOIN tblproductoscolores pc ON pd.idProductoColores = pc.idProductoColores
         JOIN tblproductos p ON pc.idProducto = p.idProducto
         JOIN tblsubcategoria sc ON p.idSubcategoria = sc.idSubCategoria -- <-- JOIN AÑADIDO
         JOIN tblcategoria c ON sc.idCategoria = c.idcategoria       -- <-- JOIN CORREGIDO
         WHERE pd.idPedido = ?`,
        [idPedido]
    );

    if (rows[0].totalCategorias >= 3) {
        await _otorgarLogro(idUsuario, ID_FIESTERO_TOTAL, connection);
    }
}


async function _tieneLogro(idUsuario, idInsignia, connection) {
    const [rows] = await connection.query(
        `SELECT 1 FROM tblLogrosCliente WHERE idUsuario = ? AND idInsignia = ? LIMIT 1;`,
        [idUsuario, idInsignia]
    );
    return rows.length > 0;
}

async function _otorgarLogro(idUsuario, idInsignia, connection) {
    const fecha = obtenerFechaMexico();
    try {
        await connection.query(
            `INSERT INTO tblLogrosCliente (idUsuario, idInsignia, fechaObtencion) VALUES (?, ?, ?);`,
            [idUsuario, idInsignia, fecha]
        );
        console.log(`¡Logro ${idInsignia} otorgado al usuario ${idUsuario}!`);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            console.warn(`Intento de otorgar logro duplicado ${idInsignia} al usuario ${idUsuario}. Ya existe.`);
        } else {
            throw error;
        }
    }
}

module.exports = {
    verificarYAsignarLogros
};