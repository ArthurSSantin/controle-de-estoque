import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import tiresRouter from './routes/tires.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API — Controle de Estoque de Pneus 🛞');
});

app.use('/api/tires', tiresRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
