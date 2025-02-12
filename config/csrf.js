const csurf = require('csurf');


const csrfProtection = csurf({
    cookie: {
        key: '_csrf',
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    },
    ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
});



module.exports = { csrfProtection};
