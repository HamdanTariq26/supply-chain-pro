'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Public health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/iot', require('./routes/iot'));
app.use('/api/benchmarks', require('./routes/benchmarks'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

async function start() {
  try {
    await require('./cassandra/client').getClient();
    await require('./fabric/gateway').enrollAdmin();
    app.listen(process.env.PORT || 3000, () => console.log('API Running on port 3000'));
  } catch (err) { console.error(err); process.exit(1); }
}
start();
