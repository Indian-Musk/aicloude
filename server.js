const express = require('express');
const session = require('express-session');
const admin = require('firebase-admin');
// Replace this line:
// const serviceAccount = require('./serviceAccountKey.json');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();

// Validate Service Account Structure
const requiredServiceAccountFields = [
  'type', 'project_id', 'private_key_id', 'private_key',
  'client_email', 'client_id', 'auth_uri', 'token_uri'
];

for (const field of requiredServiceAccountFields) {
  if (!serviceAccount[field]) {
    console.error(`🚨 Missing required service account field: ${field}`);
    process.exit(1);
  }
}

// Initialize Firebase
const databaseURL = process.env.FIREBASE_DATABASE_URL || 
  `https://${serviceAccount.project_id}.firebaseio.com`;

const firebaseApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: databaseURL
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// Express Configuration
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// ======================
//      Endpoints
// ======================

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    firebase: {
      projectId: serviceAccount.project_id,
      database: firebaseApp.options.databaseURL,
      serviceAccount: serviceAccount.client_email
    },
    session: !!process.env.SESSION_SECRET
  });
});

// User Registration
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await admin.auth().createUser({
      email: `${username}@aicloude.com`,
      password,
      emailVerified: false
    });

    await db.collection('users').doc(user.uid).set({
      username,
      isAdmin: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLogin: null
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(400).json({ 
      error: error.code === 'auth/email-already-exists' 
        ? 'Username already exists' 
        : 'Registration failed' 
    });
  }
});

// User Login
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }

    const user = await admin.auth().getUserByEmail(`${username}@aicloude.com`);
    await admin.auth().updateUser(user.uid, { password });

    const userDoc = await db.collection('users').doc(user.uid).get();
    
    if (!userDoc.exists) {
      throw new Error('User document not found');
    }

    // Update last login time
    await db.collection('users').doc(user.uid).update({
      lastLogin: admin.firestore.FieldValue.serverTimestamp()
    });

    req.session.uid = user.uid;
    req.session.isAdmin = userDoc.data().isAdmin;

    res.json({ success: true });
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Session Check
app.get('/api/user', async (req, res) => {
  try {
    if (!req.session.uid) return res.json({ loggedIn: false });

    const userDoc = await db.collection('users').doc(req.session.uid).get();
    
    if (!userDoc.exists) {
      req.session.destroy();
      return res.json({ loggedIn: false });
    }

    res.json({
      loggedIn: true,
      user: {
        username: userDoc.data().username,
        isAdmin: userDoc.data().isAdmin
      }
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({ loggedIn: false });
  }
});


console.log('Session Secret:', process.env.SESSION_SECRET ? 'Exists' : 'Missing');

// Contact Form
app.post('/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'All fields required' });
    }

    await db.collection('contacts').add({
      name,
      email,
      message,
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Contact error:', error);
    res.status(500).json({ error: 'Message submission failed' });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Firestore Test Endpoint
app.get('/test-firestore', async (req, res) => {
  try {
    const testRef = db.collection('test');
    const docRef = await testRef.add({
      testData: 'Firestore connection successful',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    const doc = await docRef.get();
    res.json({
      success: true,
      document: {
        id: doc.id,
        ...doc.data()
      }
    });
  } catch (error) {
    console.error('Firestore test failed:', error);
    res.status(500).json({ 
      error: 'Firestore connection failed',
      details: error.message 
    });
  }
});

// Client-Side Routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error Handling
app.use((err, req, res, next) => {
  console.error('🚨 Server Error:', err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message 
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  🚀 Server running successfully
  ├─ Port: ${PORT}
  ├─ Firebase Project: ${serviceAccount.project_id}
  ├─ Database: ${firebaseApp.options.databaseURL}
  └─ Service Account: ${serviceAccount.client_email}
  `);
  console.log('🔗 Health Check URL:', `http://localhost:${PORT}/health`);
});