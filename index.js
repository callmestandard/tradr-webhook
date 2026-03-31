require('dotenv').config();
const express = require('express');
const cors = require('cors');
const monoRoutes = require('./routes/mono');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TRADR server running' });
});

// Routes
app.use('/mono', monoRoutes);
app.use('/auth', authRoutes);

app.listen(PORT, () => {
  console.log(`TRADR server listening on port ${PORT}`);
});