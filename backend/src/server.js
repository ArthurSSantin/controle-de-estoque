import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import tiresRouter from './routes/tires.js';

const app = express();

// Cabeçalhos de segurança padrão (proteção contra clickjacking, sniffing, etc.)
app.use(helmet());

// CORS: em produção, só libera para os domínios listados em ALLOWED_ORIGIN.
// Sem essa variável configurada, libera geral — conveniente em dev, mas
// configure sempre em produção (veja backend/.env.example).
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
  })
);

if (allowedOrigins.length === 0) {
  console.warn(
    '⚠️  ALLOWED_ORIGIN não configurado — a API está aceitando chamadas de qualquer origem.\n' +
    '    Configure essa variável em produção (veja backend/.env.example).'
  );
}

app.use(express.json({ limit: '2mb' }));

// Limite de requisições por IP — protege contra abuso e ataques de força bruta.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // até 300 requisições por IP nesse período
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições em pouco tempo. Aguarde um instante e tente de novo.' },
});
app.use('/api', apiLimiter);

app.get('/', (req, res) => {
  res.send('API — Controle de Estoque de Pneus 🛞');
});

app.use('/api/tires', tiresRouter);

// Handler de erro genérico — evita vazar detalhes internos (stack trace, etc.)
// para quem está chamando a API.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
