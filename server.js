// server.js
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração CORS
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://0.0.0.0:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

// Middleware de logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

// Criar diretório para backups se não existir
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

// Criar/abrir banco de dados SQLite
const DB_FILE = path.join(__dirname, 'demandas.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) return console.error('❌ Erro ao abrir o banco de dados:', err);
    console.log('✅ Banco de dados SQLite pronto!');
});

// Habilitar chaves estrangeiras
db.run('PRAGMA foreign_keys = ON');

// MUDANÇA: Schema da tabela com índices para melhor performance
db.run(`
    CREATE TABLE IF NOT EXISTS demandas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        funcionarioId INTEGER NOT NULL,
        nomeFuncionario TEXT NOT NULL,
        emailFuncionario TEXT NOT NULL,
        categoria TEXT NOT NULL,
        prioridade TEXT NOT NULL,
        complexidade TEXT NOT NULL,
        descricao TEXT NOT NULL,
        local TEXT NOT NULL,
        dataCriacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dataLimite TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pendente',
        isRotina INTEGER DEFAULT 0,
        diasSemana TEXT,
        tag TEXT UNIQUE,
        comentarios TEXT DEFAULT '',
        comentarioGestor TEXT DEFAULT '',
        dataConclusao TEXT,
        atribuidos TEXT,
        dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
        criadoPor INTEGER,
        atualizadoPor INTEGER
    )
`);

// Criar índices para melhor performance
db.run('CREATE INDEX IF NOT EXISTS idx_status ON demandas(status)');
db.run('CREATE INDEX IF NOT EXISTS idx_funcionarioId ON demandas(funcionarioId)');
db.run('CREATE INDEX IF NOT EXISTS idx_dataLimite ON demandas(dataLimite)');
db.run('CREATE INDEX IF NOT EXISTS idx_tag ON demandas(tag)');
db.run('CREATE INDEX IF NOT EXISTS idx_categoria ON demandas(categoria)');
db.run('CREATE INDEX IF NOT EXISTS idx_prioridade ON demandas(prioridade)');

// Tabela de logs de auditoria
db.run(`
    CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        acao TEXT NOT NULL,
        tabela TEXT NOT NULL,
        registroId INTEGER NOT NULL,
        dadosAntigos TEXT,
        dadosNovos TEXT,
        usuarioId INTEGER,
        dataHora TEXT DEFAULT CURRENT_TIMESTAMP,
        ip TEXT
    )
`);

// Tabela de backups
db.run(`
    CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nomeArquivo TEXT NOT NULL,
        dataBackup TEXT NOT NULL,
        tamanho INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

// Rota de health check melhorada
app.get('/health', (req, res) => {
    db.get('SELECT COUNT(*) as count FROM demandas', [], (err, row) => {
        if (err) {
            console.error('Erro no health check:', err);
            return res.status(500).json({ 
                status: 'ERROR', 
                error: err.message,
                timestamp: new Date().toISOString()
            });
        }
        
        // Verificar integridade do banco
        db.get('PRAGMA integrity_check', [], (err, row) => {
            const integrity = err ? 'ERROR' : row.integrity_check;
            
            res.json({ 
                status: 'OK', 
                demandas: row.count,
                integrity: integrity,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                memory: process.memoryUsage(),
                version: '1.0.0'
            });
        });
    });
});

// Middleware para validação de dados
const validarDemanda = (req, res, next) => {
    const { nomeDemanda, categoria, prioridade, complexidade, descricao, local, dataLimite } = req.body;
    
    const erros = [];
    
    if (!nomeDemanda || nomeDemanda.trim().length < 3) {
        erros.push('Nome da demanda é obrigatório e deve ter pelo menos 3 caracteres');
    }
    
    if (!categoria) {
        erros.push('Categoria é obrigatória');
    }
    
    if (!prioridade || !['Importante', 'Média', 'Relevante'].includes(prioridade)) {
        erros.push('Prioridade é obrigatória e deve ser: Importante, Média ou Relevante');
    }
    
    if (!complexidade || !['Fácil', 'Médio', 'Difícil'].includes(complexidade)) {
        erros.push('Complexidade é obrigatória e deve ser: Fácil, Médio ou Difícil');
    }
    
    if (!descricao || descricao.trim().length < 10) {
        erros.push('Descrição é obrigatória e deve ter pelo menos 10 caracteres');
    }
    
    if (!local) {
        erros.push('Local é obrigatório');
    }
    
    if (!dataLimite) {
        erros.push('Data limite é obrigatória');
    } else {
        const dataLim = new Date(dataLimite);
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        
        if (dataLim < hoje) {
            erros.push('Data limite não pode ser anterior a hoje');
        }
    }
    
    if (erros.length > 0) {
        return res.status(400).json({ 
            success: false, 
            errors: erros,
            message: 'Dados inválidos'
        });
    }
    
    next();
};

// Função para registrar auditoria
const registrarAuditoria = (acao, tabela, registroId, dadosAntigos, dadosNovos, usuarioId, ip) => {
    const sql = `
        INSERT INTO auditoria (acao, tabela, registroId, dadosAntigos, dadosNovos, usuarioId, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(sql, [
        acao,
        tabela,
        registroId,
        JSON.stringify(dadosAntigos || {}),
        JSON.stringify(dadosNovos || {}),
        usuarioId,
        ip
    ], (err) => {
        if (err) console.error('Erro ao registrar auditoria:', err);
    });
};

// GET /api/demandas - Listar demandas com filtros e paginação
app.get('/api/demandas', (req, res) => {
    const { 
        page = 1, 
        limit = 50, 
        status, 
        funcionarioId, 
        categoria, 
        prioridade,
        dataInicio,
        dataFim,
        orderBy = 'dataCriacao',
        orderDirection = 'DESC'
    } = req.query;
    
    let sql = 'SELECT * FROM demandas WHERE 1=1';
    const params = [];
    
    // Adicionar filtros
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    
    if (funcionarioId) {
        sql += ' AND funcionarioId = ?';
        params.push(funcionarioId);
    }
    
    if (categoria) {
        sql += ' AND categoria = ?';
        params.push(categoria);
    }
    
    if (prioridade) {
        sql += ' AND prioridade = ?';
        params.push(prioridade);
    }
    
    if (dataInicio) {
        sql += ' AND dataCriacao >= ?';
        params.push(dataInicio);
    }
    
    if (dataFim) {
        sql += ' AND dataCriacao <= ?';
        params.push(dataFim);
    }
    
    // Adicionar ordenação
    const allowedOrderFields = ['dataCriacao', 'dataLimite', 'status', 'prioridade', 'categoria'];
    const field = allowedOrderFields.includes(orderBy) ? orderBy : 'dataCriacao';
    const direction = orderDirection.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    sql += ` ORDER BY ${field} ${direction}`;
    
    // Adicionar paginação
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    
    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('Erro ao buscar demandas:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // Contar total para paginação
        const countSql = sql.replace(/SELECT \* FROM/, 'SELECT COUNT(*) FROM').replace(/ORDER BY.*LIMIT.*OFFSET.*/, '');
        db.get(countSql, params.slice(0, -2), (err, countRow) => {
            if (err) {
                console.error('Erro ao contar demandas:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            res.json({
                success: true,
                data: rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countRow.count,
                    pages: Math.ceil(countRow.count / parseInt(limit))
                }
            });
        });
    });
});

// POST /api/demandas - Criar nova demanda
app.post('/api/demandas', validarDemanda, (req, res) => {
    const d = req.body;
    
    // Gerar TAG única se não fornecida
    if (!d.tag) {
        d.tag = `DEM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    const sql = `
        INSERT INTO demandas 
        (funcionarioId, nomeFuncionario, emailFuncionario, categoria, prioridade, complexidade, descricao, local, dataCriacao, dataLimite, status, isRotina, diasSemana, tag, comentarios, comentarioGestor, atribuidos, criadoPor)
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
        d.atribuidos ? JSON.stringify(d.atribuidos) : null,
        d.funcionarioId // Criado por quem criou
    ];
    
    db.run(sql, params, function(err) {
        if (err) {
            console.error('Erro ao criar demanda:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // Registrar auditoria
        registrarAuditoria(
            'CREATE',
            'demandas',
            this.lastID,
            null,
            d,
            d.funcionarioId,
            req.ip
        );
        
        // Criar backup automático
        criarBackup('auto');
        
        res.json({ 
            success: true, 
            demanda: { id: this.lastID, ...d, dataCriacao: params[8] }
        });
    });
});

// PUT /api/demandas/:id - Atualizar demanda
app.put('/api/demandas/:id', validarDemanda, (req, res) => {
    const id = req.params.id;
    const d = req.body;
    
    // Buscar demanda existente
    db.get('SELECT * FROM demandas WHERE id = ?', [id], (err, demandaExistente) => {
        if (err) {
            console.error('Erro ao buscar demanda:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!demandaExistente) {
            return res.status(404).json({ success: false, error: 'Demanda não encontrada' });
        }
        
        const dadosCompletos = { ...demandaExistente, ...d };
        
        // Manter campos que não devem ser alterados
        delete dadosCompletos.id;
        delete dadosCompletos.dataCriacao;
        delete dadosCompletos.criadoPor;
        
        // Atualizar data de modificação
        dadosCompletos.dataAtualizacao = new Date().toISOString();
        dadosCompletos.atualizadoPor = d.funcionarioId;
        
        const sql = `
            UPDATE demandas SET
            funcionarioId = ?, nomeFuncionario = ?, emailFuncionario = ?, categoria = ?, prioridade = ?, 
            complexidade = ?, descricao = ?, local = ?, dataLimite = ?, status = ?, 
            isRotina = ?, diasSemana = ?, tag = ?, comentarios = ?, comentarioGestor = ?, 
            dataConclusao = ?, atribuidos = ?, dataAtualizacao = ?, atualizadoPor = ?
            WHERE id = ?
        `;
        
        const params = [
            dadosCompletos.funcionarioId,
            dadosCompletos.nomeFuncionario,
            dadosCompletos.emailFuncionario,
            dadosCompletos.categoria,
            dadosCompletos.prioridade,
            dadosCompletos.complexidade,
            dadosCompletos.descricao,
            dadosCompletos.local,
            dadosCompletos.dataLimite,
            dadosCompletos.status,
            dadosCompletos.isRotina ? 1 : 0,
            dadosCompletos.diasSemana ? JSON.stringify(dadosCompletos.diasSemana) : null,
            dadosCompletos.tag,
            dadosCompletos.comentarios || '',
            dadosCompletos.comentarioGestor || '',
            dadosCompletos.dataConclusao || null,
            dadosCompletos.atribuidos ? JSON.stringify(dadosCompletos.atribuidos) : null,
            dadosCompletos.dataAtualizacao,
            dadosCompletos.atualizadoPor,
            id
        ];
        
        db.run(sql, params, function(err) {
            if (err) {
                console.error('Erro ao atualizar demanda:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            // Registrar auditoria
            registrarAuditoria(
                'UPDATE',
                'demandas',
                id,
                demandaExistente,
                dadosCompletos,
                d.funcionarioId,
                req.ip
            );
            
            // Criar backup automático para atualizações críticas
            if (['aprovada', 'reprovada'].includes(d.status)) {
                criarBackup('status_change');
            }
            
            res.json({ 
                success: true, 
                demanda: { id: parseInt(id), ...dadosCompletos }
            });
        });
    });
});

// DELETE /api/demandas/:id - Excluir demanda
app.delete('/api/demandas/:id', (req, res) => {
    const id = req.params.id;
    
    // Buscar demanda antes de excluir
    db.get('SELECT * FROM demandas WHERE id = ?', [id], (err, demanda) => {
        if (err) {
            console.error('Erro ao buscar demanda para exclusão:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!demanda) {
            return res.status(404).json({ success: false, error: 'Demanda não encontrada' });
        }
        
        db.run('DELETE FROM demandas WHERE id = ?', [id], function(err) {
            if (err) {
                console.error('Erro ao excluir demanda:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            // Registrar auditoria
            registrarAuditoria(
                'DELETE',
                'demandas',
                id,
                demanda,
                null,
                req.body.usuarioId || null,
                req.ip
            );
            
            // Criar backup antes de excluir
            criarBackup('delete');
            
            res.json({ success: true });
        });
    });
});

// NOVO: GET /api/demandas/estatisticas - Estatísticas detalhadas
app.get('/api/demandas/estatisticas', (req, res) => {
    const { periodo = 30 } = req.query;
    
    const dataCorte = new Date();
    dataCorte.setDate(dataCorte.getDate() - parseInt(periodo));
    
    const sql = `
        SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN status = 'aprovada' THEN 1 END) as aprovadas,
            COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes,
            COUNT(CASE WHEN status = 'reprovada' THEN 1 END) as reprovadas,
            COUNT(CASE WHEN status = 'finalizado_pendente_aprovacao' THEN 1 END) em_analise,
            COUNT(CASE WHEN isRotina = 1 THEN 1 END) as rotina,
            AVG(CASE WHEN status = 'aprovada' AND dataConclusao IS NOT NULL 
                AND dataLimite IS NOT NULL THEN 
                    (julianday(dataConclusao) - julianday(dataLimite)) 
                END) as media_dias_atraso
        FROM demandas 
        WHERE dataCriacao >= ?
    `;
    
    db.get(sql, [dataCorte.toISOString()], (err, row) => {
        if (err) {
            console.error('Erro ao buscar estatísticas:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        res.json({ success: true, estatisticas: row });
    });
});

// NOVO: GET /api/demandas/search - Busca textual
app.get('/api/demandas/search', (req, res) => {
    const { q, limit = 20 } = req.query;
    
    if (!q || q.length < 2) {
        return res.json({ success: true, data: [] });
    }
    
    const sql = `
        SELECT * FROM demandas 
        WHERE nomeDemanda LIKE ? OR descricao LIKE ? OR tag LIKE ?
        ORDER BY 
            CASE 
                WHEN nomeDemanda LIKE ? THEN 1
                WHEN descricao LIKE ? THEN 2
                ELSE 3
            END,
            dataLimite ASC
        LIMIT ?
    `;
    
    const searchTerm = `%${q}%`;
    
    db.all(sql, [searchTerm, searchTerm, searchTerm, limit], (err, rows) => {
        if (err) {
            console.error('Erro na busca:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        res.json({ success: true, data: rows });
    });
});

// NOVO: POST /api/backup - Criar backup manual
app.post('/api/backup', (req, res) => {
    const { tipo = 'manual' } = req.body;
    
    criarBackup(tipo, (err, filename) => {
        if (err) {
            console.error('Erro ao criar backup:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        res.json({ 
            success: true, 
            message: `Backup criado com sucesso`,
            filename: filename
        });
    });
});

// NOVO: GET /api/backups - Listar backups
app.get('/api/backups', (req, res) => {
    db.all('SELECT * FROM backups ORDER BY dataCriacao DESC', [], (err, rows) => {
        if (err) {
            console.error('Erro ao listar backups:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        res.json({ success: true, backups: rows });
    });
});

// NOVO: POST /api/restore - Restaurar backup
app.post('/api/restore', (req, res) => {
    const { backupId } = req.body;
    
    if (!backupId) {
        return res.status(400).json({ success: false, error: 'ID do backup é obrigatório' });
    }
    
    // Buscar informações do backup
    db.get('SELECT * FROM backups WHERE id = ?', [backupId], (err, backup) => {
        if (err) {
            console.error('Erro ao buscar backup:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!backup) {
            return res.status(404).json({ success: false, error: 'Backup não encontrado' });
        }
        
        try {
            const backupPath = path.join(backupDir, backup.nomeArquivo);
            const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            
            // Restaurar dados
            if (backupData.demandas && Array.isArray(backupData.demandas)) {
                // Limpar tabela atual (cuidado!)
                db.run('DELETE FROM demandas', [], (err) => {
                    if (err) {
                        console.error('Erro ao limpar demandas:', err);
                        return res.status(500).json({ success: false, error: err.message });
                    }
                    
                    // Inserir dados do backup
                    const insertSql = `
                        INSERT INTO demandas 
                        (funcionarioId, nomeFuncionario, emailFuncionario, categoria, prioridade, complexidade, descricao, local, dataCriacao, dataLimite, status, isRotina, diasSemana, tag, comentarios, comentarioGestor, dataConclusao, atribuidos, criadoPor)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;
                    
                    backupData.demandas.forEach((demanda, index) => {
                        const params = [
                            demanda.funcionarioId,
                            demanda.nomeFuncionario,
                            demanda.emailFuncionario,
                            demanda.categoria,
                            demanda.prioridade,
                            demanda.complexidade,
                            demanda.descricao,
                            demanda.local,
                            demanda.dataCriacao,
                            demanda.dataLimite,
                            demanda.status,
                            demanda.isRotina ? 1 : 0,
                            demanda.diasSemana ? JSON.stringify(demanda.diasSemana) : null,
                            demanda.tag,
                            demanda.comentarios || '',
                            demanda.comentarioGestor || '',
                            demanda.dataConclusao || null,
                            demanda.atribuidos ? JSON.stringify(demanda.atribuidos) : null,
                            demanda.criadoPor
                        ];
                        
                        db.run(insertSql, params, (err) => {
                            if (err) {
                                console.error(`Erro ao restaurar demanda ${index}:`, err);
                            }
                        });
                    });
                    
                    res.json({ 
                        success: true, 
                        message: `Backup restaurado com sucesso! ${backupData.demandas.length} demandas foram restauradas.`
                    });
                });
            }
        } catch (error) {
            console.error('Erro ao restaurar backup:', error);
            res.status(500).json({ success: false, error: 'Erro ao processar arquivo de backup' });
        }
    });
});

// Função para criar backups
const criarBackup = (tipo = 'auto', callback) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup_${tipo}_${timestamp}.json`;
    const backupPath = path.join(backupDir, filename);
    
    // Buscar todas as demandas
    db.all('SELECT * FROM demandas', [], (err, rows) => {
        if (err) {
            console.error('Erro ao buscar demandas para backup:', err);
            if (callback) callback(err);
            return;
        }
        
        const backupData = {
            versao: '1.0.0',
            data: timestamp,
            tipo: tipo,
            totalDemandas: rows.length,
            demandas: rows
        };
        
        fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), (err) => {
            if (err) {
                console.error('Erro ao salvar backup:', err);
                if (callback) callback(err);
                return;
            }
            
            // Salvar informações do backup no banco
            db.run(
                'INSERT INTO backups (nomeArquivo, dataBackup, tamanho, tipo) VALUES (?, ?, ?, ?)',
                [filename, JSON.stringify(backupData), backupData.length, tipo],
                (err) => {
                    if (err) console.error('Erro ao registrar backup no banco:', err);
                }
            );
            
            // Manter apenas os últimos 10 backups automáticos
            if (tipo === 'auto') {
                db.all(
                    'SELECT id FROM backups WHERE tipo = "auto" ORDER BY dataCriacao DESC LIMIT 10, 999999',
                    [],
                    (err, rows) => {
                        if (err) return;
                        
                        if (rows.length > 0) {
                            const idsParaManter = rows.map(r => r.id).join(',');
                            db.run(`DELETE FROM backups WHERE tipo = "auto" AND id NOT IN (${idsParaManter})`);
                        }
                    }
                );
            }
            
            console.log(`✅ Backup ${tipo} criado: ${filename}`);
            if (callback) callback(null, filename);
        });
    });
};

// Agendar backups automáticos a cada 6 horas
setInterval(() => {
    criarBackup('auto');
}, 6 * 60 * 60 * 1000);

// Limpar backups antigos (manter apenas 30 dias)
setInterval(() => {
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - 30);
    
    db.run(
        'DELETE FROM backups WHERE dataCriacao < ?',
        [dataLimite.toISOString()],
        (err) => {
            if (err) console.error('Erro ao limpar backups antigos:', err);
        }
    );
}, 24 * 60 * 60 * 1000);

// Tratamento de erros global
app.use((err, req, res, next) => {
    console.error('❌ Erro não tratado:', err);
    
    // Registrar erro em log
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${err.stack}\n`;
    
    fs.appendFile(path.join(__dirname, 'error.log'), logEntry, (fsErr) => {
        if (fsErr) console.error('Erro ao escrever no log de erros:', fsErr);
    });
    
    res.status(500).json({
        success: false,
        error: 'Erro interno do servidor',
        message: process.env.NODE_ENV === 'production' ? 'Erro interno' : err.message,
        timestamp
    });
});

// Rota 404 personalizada
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Rota não encontrada',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado em porta ${PORT}`);
    console.log(`📁 Diretório de backups: ${backupDir}`);
    console.log(`📊 Logs de erros: ${path.join(__dirname, 'error.log')}`);
    console.log(`⏰ Backups automáticos agendados a cada 6 horas`);
    console.log(`🗑️ Limpeza de backups antigos a cada 24 horas`);
});

// Tratamento de encerramento gracioso
process.on('SIGINT', () => {
    console.log('\n🛑 Recebido SIGINT. Criando backup final...');
    
    criarBackup('shutdown', (err, filename) => {
        if (err) {
            console.error('Erro ao criar backup final:', err);
        } else {
            console.log(`✅ Backup final criado: ${filename}`);
        }
        
        console.log('👋 Encerrando servidor...');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Recebido SIGTERM. Encerrando servidor...');
    process.exit(0);
});
