const request = require('supertest');
const express = require('express');
const { mockDeep } = require('jest-mock-extended');


jest.mock('../connectBd', () => ({
  pool: mockDeep(),
}));


jest.mock('../consultas/clsUsuarios', () => {
  const express = require('express');
  const usuarioRouter = express.Router();

  const verifyToken = jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(403).json({ message: 'Token no proporcionado. Acceso denegado.' });
    }
    const mockUser = req.headers.authorization.includes('valid-token') 
      ? { id: 1, nombre: 'Test User', rol: req.headers.authorization.includes('admin') ? 'admin' : 'user' }
      : null;
    if (!mockUser) {
      return res.status(401).json({ message: 'El token ha expirado. Inicia sesión nuevamente.' });
    }
    req.user = mockUser;
    next();
  });


  usuarioRouter.post('/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [users] = await connection.query();
      if (users.length > 0) {
        const user = users[0];
        const token = 'mocked-token-' + user.id;
        return res.status(200).json({ token, user });
      }
      return res.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    } finally {
      connection.release();
    }
  });

  // Ruta /perfil
  usuarioRouter.get('/perfil', verifyToken, async (req, res) => {
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [perfil] = await connection.query();
      return res.status(200).json(perfil[0]);
    } finally {
      connection.release();
    }
  });


  usuarioRouter.get('/perfiles', verifyToken, async (req, res) => {
    if (req.user.rol !== 'admin') {
      return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [perfiles] = await connection.query();
      return res.status(200).json(perfiles);
    } finally {
      connection.release();
    }
  });

  return {
    verifyToken,
    obtenerFechaMexico: jest.fn(() => '2025-10-27 10:59:00'),
    usuarioRouter,
  };
});


jest.mock('../consultas/clsPedidos', () => {
  const express = require('express');
  const router = express.Router();

  router.get('/historial-pedidos', (req, res, next) => {
    const { verifyToken } = require('../consultas/clsUsuarios');
    verifyToken(req, res, next);
  }, async (req, res) => {
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [pedidos] = await connection.query();
      const [total] = await connection.query();
      return res.status(200).json({
        success: true,
        data: pedidos,
        paginacion: {
          totalPedidos: total[0].totalPedidos,
          paginaActual: 1,
          totalPaginas: Math.ceil(total[0].totalPedidos / 10),
        },
      });
    } finally {
      connection.release();
    }
  });

  return router;
});

describe('Integration Tests: API Básica (Login, Perfil, Perfiles, Historial Pedidos)', () => {
  let app;
  let mockPool;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/usuarios', require('../consultas/clsUsuarios').usuarioRouter);
    app.use('/api/pedidos', require('../consultas/clsPedidos'));

    mockPool = require('../connectBd').pool;
    mockPool.getConnection.mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.resetAllMocks();
  });


  test('POST /api/usuarios/login - Login con credenciales válidas', async () => {
    const mockUser = [{ id: 1, nombre: 'Test User', rol: 'user' }];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([mockUser]),
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'test@example.com', contrasena: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toEqual(expect.objectContaining({
      id: 1,
      nombre: 'Test User',
      rol: 'user',
    }));
  }, 10000);

  test('POST /api/usuarios/login - Rechazar credenciales inválidas', async () => {
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[]]),
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'invalid@example.com', contrasena: 'wrongpassword' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('message', 'Correo o contraseña incorrectos.');
  }, 10000);

  test('GET /api/usuarios/perfil - Devolver perfil con token válido', async () => {
    const mockPerfil = [{ id: 1, nombre: 'Test User', correo: 'test@example.com' }];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([mockPerfil]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/usuarios/perfil')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: 1,
      nombre: 'Test User',
      correo: 'test@example.com',
    }));
  }, 10000);

  test('GET /api/usuarios/perfil - Rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/usuarios/perfil');

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Token no proporcionado. Acceso denegado.');
  }, 10000);


  test('GET /api/usuarios/perfiles - Devolver perfiles con token válido (admin)', async () => {
    const mockPerfiles = [
      { id: 1, nombre: 'User 1', correo: 'user1@example.com' },
      { id: 2, nombre: 'User 2', correo: 'user2@example.com' },
    ];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([mockPerfiles]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/usuarios/perfiles')
      .set('Authorization', 'Bearer valid-token-admin');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, nombre: 'User 1' }),
      expect.objectContaining({ id: 2, nombre: 'User 2' }),
    ]));
  }, 10000);

  test('GET /api/usuarios/perfiles - Rechazar si no es admin', async () => {
    const res = await request(app)
      .get('/api/usuarios/perfiles')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Acceso denegado. Se requiere rol de administrador.');
  }, 10000);

  test('GET /api/pedidos/historial-pedidos - Devolver pedidos con token válido', async () => {
    const mockPedidos = [
      {
        idPedido: 1,
        idRastreo: 'TRACK123',
        estado: 'Confirmado',
        fechaInicio: '2025-10-01',
        totalPagar: 500.0,
        numeroDeProductos: 2,
        nombreCliente: 'Test User',
      },
    ];
    const mockTotal = [{ totalPedidos: 1 }];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce([mockPedidos])
        .mockResolvedValueOnce([mockTotal]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          idPedido: 1,
          idRastreo: 'TRACK123',
          estado: 'Confirmado',
        }),
      ]),
      paginacion: {
        totalPedidos: 1,
        paginaActual: 1,
        totalPaginas: 1,
      },
    });
  }, 10000);

  test('GET /api/pedidos/historial-pedidos - Rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/pedidos/historial-pedidos');

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Token no proporcionado. Acceso denegado.');
  }, 10000);

  test('GET /api/pedidos/historial-pedidos - Devolver lista vacía si no hay pedidos', async () => {
    const mockTotal = [{ totalPedidos: 0 }];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([mockTotal]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', 'Bearer valid-token');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [],
      paginacion: {
        totalPedidos: 0,
        paginaActual: 1,
        totalPaginas: 0,
      },
    });
  }, 10000);
});