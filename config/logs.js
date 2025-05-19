const winston = require('winston');

// Definir niveles personalizados
const customLevels = {
  levels: {
    error: 0,   // Errores críticos
    warn: 1,    // Advertencias
    info: 2,    // Información general
    audit: 3,   // Auditoría de acciones
    debug: 4,   // Depuración detallada
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    audit: 'blue',
    debug: 'gray',
  },
};


const detailedFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.metadata(), 
  winston.format.json()      
);

const logger = winston.createLogger({
  levels: customLevels.levels, 
  level: 'debug',             
  format: detailedFormat,
  transports: [
    
    new winston.transports.File({
      filename: 'logs/errors.log',
      level: 'error',
      maxLevel: 'error', 
    }),

    new winston.transports.File({
      filename: 'logs/warnings.log',
      level: 'warn',
      maxLevel: 'warn', 
    }),
   
    new winston.transports.File({
      filename: 'logs/info.log',
      level: 'info',
      maxLevel: 'info', 
    }),
   
    new winston.transports.File({
      filename: 'logs/audit.log',
      level: 'audit',
      maxLevel: 'audit', 
    }),
  
    new winston.transports.File({
      filename: 'logs/debug.log',
      level: 'debug',
      maxLevel: 'debug',
    }),
   
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

winston.addColors(customLevels.colors);


logger.audit = function (message, meta) {
  this.log({ level: 'audit', message, ...meta });
};
logger.debug = function (message, meta) {
  this.log({ level: 'debug', message, ...meta });
};

module.exports = logger;