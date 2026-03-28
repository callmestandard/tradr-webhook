require('dotenv').config();

const express = require('express');
const cors = require('cors');
const monoRoutes = require('./routes/mono');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'TRADR server running' });
});

app.use('/mono', monoRoutes);

app.listen(PORT, () => {
  console.log(`TRADR server listening on port ${PORT}`);
});
