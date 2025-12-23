// server.js
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração CORS
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// Criar/abrir banco de dados SQLite
const DB_FILE = path.join(__dirname, 'demandas.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) return console.error('Erro ao abrir o banco de dados:', err);
    console.log('✅ Banco de dados SQLite pronto!');
});

// Criar tabela de demandas se não existir
db.run(`
    CREATE TABLE IF NOT EXISTS demandas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        funcionarioId INTEGER,
        nomeFuncionario TEXT,
        emailFuncionario TEXT,
        categoria TEXT,
        prioridade TEXT,
        complexidade TEXT,
        descricao TEXT,
        local TEXT,
        dataCriacao TEXT,
        dataLimite TEXT,
        status TEXT,
        isRotina INTEGER,
        diasSemana TEXT, -- Armazenado como string JSON
        tag TEXT,
        comentarios TEXT,
        comentarioGestor TEXT,
        dataConclusao TEXT,
        atribuidos TEXT -- Armazenado como string JSON
    )
`);

// Rota principal para servir o index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------- ROTAS ------------------

// GET /api/demandas
app.get('/api/demandas', (req, res) => {
    db.all('SELECT * FROM demandas', [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        // MUDANÇA CRÍTICA: Processa cada linha para converter strings JSON de volta para objetos/arrays
        const processedRows = rows.map(row => {
            // Converter diasSemana de string para array, se existir
            if (row.diasSemana) {
                try {
                    row.diasSemana = JSON.parse(row.diasSemana);
                } catch (e) {
                    // Se falhar o parse, garante que seja um array vazio para não quebrar o frontend
                    row.diasSemana = [];
                }
            } else {
                row.diasSemana = [];
            }

            // Converter atribuidos de string para array, se existir
            if (row.atribuidos) {
                try {
                    row.atribuidos = JSON.parse(row.atribuidos);
                } catch (e) {
                    row.atribuidos = [];
                }
            } else {
                row.atribuidos = [];
            }

            // Converte isRotina de número (0/1) para booleano (true/false)
            row.isRotina = Boolean(row.isRotina);

            return row;
        });

        res.json(processedRows);
    });
});

// POST /api/demandas
app.post('/api/demandas', (req, res) => {
    const d = req.body;
    const sql = `
        INSERT INTO demandas 
        (funcionarioId, nomeFuncionario, emailFuncionario, categoria, prioridade, complexidade, descricao, local, dataCriacao, dataLimite, status, isRotina, diasSemana, tag, comentarios, comentarioGestor, atribuidos)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        d.funcionarioId,
        d.nomeFuncionario,
        d.emailFuncionario,
        d.categoria,
        d.prioridade,
        d.complexidade,
        d.descricao,
        d.local,
        d.dataCriacao || new Date().toISOString(),
        d.dataLimite,
        d.status || 'pendente',
        d.isRotina ? 1 : 0,
        d.diasSemana ? JSON.stringify(d.diasSemana) : null,
        d.tag,
        d.comentarios || '',
        d.comentarioGestor || '',
        d.atribuidos ? JSON.stringify(d.atribuidos) : null
    ];
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, demanda: { id: this.lastID, ...d, dataCriacao: params[8] } });
    });
});

// PUT /api/demandas/:id
app.put('/api/demandas/:id', (req, res) => {
    const d = req.body;
    const id = req.params.id;
    const sql = `
        UPDATE demandas SET
        funcionarioId = ?, nomeFuncionario = ?, emailFuncionario = ?, categoria = ?, prioridade = ?, complexidade = ?, descricao = ?, local = ?, dataLimite = ?, status = ?, isRotina = ?, diasSemana = ?, tag = ?, comentarios = ?, comentarioGestor = ?, dataConclusao = ?, atribuidos = ?
        WHERE id = ?
    `;
    const params = [
        d.funcionarioId,
        d.nomeFuncionario,
        d.emailFuncionario,
        d.categoria,
        d.prioridade,
        d.complexidade,
        d.descricao,
        d.local,
        d.dataLimite,
        d.status,
        d.isRotina ? 1 : 0,
        d.diasSemana ? JSON.stringify(d.diasSemana) : null,
        d.tag,
        d.comentarios || '',
        d.comentarioGestor || '',
        d.dataConclusao || null,
        d.atribuidos ? JSON.stringify(d.atribuidos) : null,
        id
    ];
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, demanda: { id: Number(id), ...d } });
    });
});

// DELETE /api/demandas/:id
app.delete('/api/demandas/:id', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM demandas WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// Health check
app.get('/health', (req, res) => {
    db.get('SELECT COUNT(*) as count FROM demandas', [], (err, row) => {
        if (err) return res.status(500).json({ status: 'ERROR', error: err.message });
        res.json({ status: 'OK', demandas: row.count });
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado em porta ${PORT}`);
});
