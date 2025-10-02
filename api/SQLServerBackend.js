// api/SQLServerBackend.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Sequelize from 'sequelize';
import tedious from 'tedious';
import serverless from 'serverless-http';

// ─────────────────────────────────────────────────────────────
// Configuración DB (pool optimizado para serverless)
// ─────────────────────────────────────────────────────────────
const {
  DB_HOST,
  DB_PORT = '1433',
  DB_NAME,
  DB_USER,
  DB_PASS,
  LOG_LEVEL = 'info'
} = process.env;

if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASS) {
  console.error('[SQLServerBackend] ❌ Faltan variables DB_* en el entorno.');
}

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host: DB_HOST,
  port: Number(DB_PORT),
  dialect: 'mssql',
  dialectModule: tedious,
  dialectOptions: { encrypt: true },
  logging: LOG_LEVEL === 'debug' ? console.log : false,
  pool: {
    max: 3,        // chico para serverless
    min: 0,
    acquire: 20000,
    idle: 10000
  }
});

// ─────────────────────────────────────────────────────────────
// Modelos
// ─────────────────────────────────────────────────────────────
const User = sequelize.define('users', {
  user_id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: Sequelize.STRING, unique: true },
  email: { type: Sequelize.STRING, unique: true },
  password_hash: Sequelize.STRING,
  first_name: Sequelize.STRING,
  last_name: Sequelize.STRING,
  created_at: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
  updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
  last_login: { type: Sequelize.DATE, defaultValue: Sequelize.literal('1900-01-01 00:00:00') },
  is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
  role_id: { type: Sequelize.INTEGER }
}, { timestamps: false });

const UserRole = sequelize.define('user_roles', {
  role_id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  role_name: { type: Sequelize.STRING, allowNull: false }
}, { timestamps: false });

const Property = sequelize.define('properties', {
  property_id: { type: Sequelize.INTEGER, primaryKey: true },
  property_name: Sequelize.STRING,
  property_description: Sequelize.TEXT,
  api_key: Sequelize.TEXT,
  chatbot: Sequelize.INTEGER,
  short_name: Sequelize.TEXT,
  chatbot_rate: Sequelize.FLOAT
}, { timestamps: false });

const Apartment = sequelize.define('apartments', {
  apartment_id: { type: Sequelize.INTEGER, primaryKey: true },
  apartment_wubook_shortname: Sequelize.TEXT,
  apartment_name: Sequelize.TEXT,
  apartment_description: Sequelize.TEXT,
  property_id: Sequelize.INTEGER,
  consulta: Sequelize.INTEGER,
  chatbot: Sequelize.INTEGER
}, { timestamps: false });

// Relaciones
User.belongsTo(UserRole, { foreignKey: 'role_id' });
UserRole.hasMany(User, { foreignKey: 'role_id' });

Property.hasMany(Apartment, { foreignKey: 'property_id' });
Apartment.belongsTo(Property, { foreignKey: 'property_id' });

const UserApartment = sequelize.define('user_apartments', {
  user_id: { type: Sequelize.INTEGER, primaryKey: true },
  apartment_id: { type: Sequelize.INTEGER, primaryKey: true }
}, { timestamps: false });

User.belongsToMany(Apartment, { through: UserApartment, foreignKey: 'user_id' });
Apartment.belongsToMany(User, { through: UserApartment, foreignKey: 'apartment_id' });

// ─────────────────────────────────────────────────────────────
// App Express (serverless)
// ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Preflight (CORS) rápido
app.options('/api/SQLServerBackend', (req, res) => res.status(200).end());

// Utilidades
const mask = (s) => (s ? s.slice(0, 4) + '***' : '');
const log = (...a) => (LOG_LEVEL !== 'silent' ? console.log('[SQLServerBackend]', ...a) : null);

// Re-uso de conexión: pequeño ping para abrir pool en frío
async function ensureConnection() {
  try {
    await sequelize.query('SELECT 1 AS ok');
  } catch (e) {
    log('❌ Error de conexión:', e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────
async function warmUp(req, res) {
  log('warmup()');
  try {
    await ensureConnection();
    res.status(200).json({ success: true, message: 'Database connection warmed up' });
  } catch (error) {
    log('Warm-up error:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function login(req, res) {
  log('login()');
  const { username, password } = req.body || {};
  try {
    await ensureConnection();
    const user = await User.findOne({ where: { username }, include: [{ model: UserRole }] });
    if (user && user.password_hash === password) {
      log('User:', user.user_id, user.username);
      res.json({
        success: true,
        userId: user.user_id,
        firstName: user.first_name,
        lastName: user.last_name,
        roleId: user.role_id
      });
    } else {
      res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  } catch (error) {
    log('Login error:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function properties(req, res) {
  log('properties()', 'userId=', req.query?.userId);
  const { userId } = req.query;
  try {
    await ensureConnection();

    let props;
    if (parseInt(userId, 10) === 1) {
      // admin: todas las propiedades
      props = await Property.findAll({
        attributes: ['property_id', 'property_name', 'property_description', 'api_key', 'chatbot', 'short_name', 'chatbot_rate'],
        include: [{ model: Apartment, required: true }]
      });
    } else {
      // no admin: sólo permitidas por user_apartments
      props = await Property.findAll({
        attributes: ['property_id', 'property_name', 'property_description', 'api_key', 'chatbot', 'short_name', 'chatbot_rate'],
        include: [{
          model: Apartment,
          required: true,
          include: [{
            model: User,
            required: true,
            through: { where: { user_id: userId } }
          }]
        }]
      });
    }

    log('properties ->', props?.length || 0);
    // Simplemente devuelve los objetos de Sequelize. res.json() los serializará correctamente.
    res.json(props);

  } catch (error) {
    log('Error fetching properties:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function apartments(req, res) {
  log('apartments()', 'propertyId=', req.query?.propertyId, 'userId=', req.query?.userId);
  const { propertyId, userId } = req.query;
  try {
    await ensureConnection();

    const user = await User.findOne({ where: { user_id: userId }, include: [{ model: UserRole }] });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let apts;
    if (Number(user.role_id) === 1) {
      apts = await Apartment.findAll({ where: { property_id: propertyId } });
    } else {
      apts = await Apartment.findAll({
        where: { property_id: propertyId },
        include: [{
          model: User,
          required: true,
          through: { where: { user_id: userId } }
        }]
      });
    }

    log('apartments ->', apts?.length || 0);
    res.json(apts);
  } catch (error) {
    log('Error fetching apartments:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────
// Rutas
// ─────────────────────────────────────────────────────────────
app.get('/api/SQLServerBackend', async (req, res) => {
  const { action } = req.query || {};
  try {
    if (action === 'warmup') return warmUp(req, res);
    if (action === 'properties') return properties(req, res);
    if (action === 'apartments') return apartments(req, res);
    return res.status(404).json({ message: 'Route not found' });
  } catch (e) {
    log('GET router error:', e.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/SQLServerBackend', async (req, res) => {
  const { action } = req.query || {};
  try {
    if (action === 'login') return login(req, res);
    return res.status(404).json({ message: 'Route not found' });
  } catch (e) {
    log('POST router error:', e.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// Export serverless handler (sin app.listen)
// ─────────────────────────────────────────────────────────────
export default serverless(app);
