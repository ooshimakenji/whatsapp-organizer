import fs from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// CONFIGURAÇÕES
// ============================================

const CONFIG = {
  inputDir: path.join(__dirname, 'input'),
  outputDir: path.join(__dirname, 'output-feedback'),
  logsDir: path.join(__dirname, 'logs'),
  toleranciaMinutos: 2,
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
  concorrencia: 10,
  dryRun: process.argv.includes('--dry-run'),
};

// Regex compilado uma vez só
const REGEX = {
  mensagem: /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+-\s+([^:]+):\s*(.*)$/,
  anexo: /‎?(.+\.(jpg|jpeg|png|mp4))\s*\(arquivo anexado\)/i,
  numeroLegenda: /^(\d+)/,
  // Protocolo válido: 10 dígitos começando com 20XX (antes era fixo em 2025/2026 e quebraria em 2027)
  protocoloValido: /^(20\d{8})$/,
};

// Alertas acumulados
const alertas = [];

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================

function getTimestamp() {
  const now = new Date();
  return now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
}

function sanitizarNomeAutor(autor) {
  if (!autor) return 'desconhecido';

  if (autor.startsWith('+')) {
    return autor.replace(/[+\s]/g, '').replace(/-/g, '-');
  }

  return autor.replace(/[<>:"/\\|?*]/g, '').trim();
}

function formatarTimestampArquivo(data) {
  if (!data) return 'sem-data';
  const d = new Date(data);
  if (isNaN(d.getTime())) return 'sem-data';

  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');

  return `${ano}-${mes}-${dia}_${hora}-${min}`;
}

function diferencaMinutos(data1, data2) {
  if (!data1 || !data2) return Infinity;
  const d1 = new Date(data1);
  const d2 = new Date(data2);
  return Math.abs(d1 - d2) / (1000 * 60);
}

function extrairNumeroLegenda(texto) {
  if (!texto) return null;
  const match = texto.trim().match(REGEX.numeroLegenda);
  return match ? match[1] : null;
}

// Valida se o número é um protocolo válido (10 dígitos, começa com 2025 ou 2026)
function isProtocoloValido(numero) {
  if (!numero) return false;
  return REGEX.protocoloValido.test(numero);
}

function adicionarAlerta(tipo, mensagem) {
  const icones = {
    'midia_oculta': '⚠️',
    'info': '📋',
    'arquivo_nao_encontrado': '❌',
    'protocolo_invalido': '🔢',
  };
  alertas.push(`${icones[tipo] || '•'} ${mensagem}`);
}

// ============================================
// PROGRESSO VISUAL
// ============================================

function mostrarProgresso(atual, total, prefixo = 'Progresso') {
  const porcentagem = Math.round((atual / total) * 100);
  const barraSize = 30;
  const preenchido = Math.round((atual / total) * barraSize);
  const vazio = barraSize - preenchido;
  const barra = '█'.repeat(preenchido) + '░'.repeat(vazio);

  process.stdout.write(`\r   ${prefixo}: ${barra} ${porcentagem}% (${atual}/${total})`);

  if (atual === total) {
    console.log();
  }
}

// ============================================
// PARSER DO CHAT
// ============================================

function parseChat(conteudo) {
  const linhas = conteudo.split('\n');
  const mensagens = [];

  let mensagemAtual = null;

  for (const linha of linhas) {
    const match = linha.match(REGEX.mensagem);

    if (match) {
      if (mensagemAtual) {
        mensagens.push(mensagemAtual);
      }

      const [_, dataStr, horaStr, autor, conteudoMsg] = match;
      const [dia, mes, ano] = dataStr.split('/');
      const [hora, minuto] = horaStr.split(':');
      const data = new Date(ano, mes - 1, dia, hora, minuto);

      mensagemAtual = {
        data,
        dataStr: `${dataStr} ${horaStr}`,
        autor: autor.trim(),
        conteudo: conteudoMsg.trim(),
        linhasContinuacao: [],
      };
    } else if (mensagemAtual && linha.trim()) {
      mensagemAtual.linhasContinuacao.push(linha.trim());
    }
  }

  if (mensagemAtual) {
    mensagens.push(mensagemAtual);
  }

  return mensagens;
}

function extrairMidia(mensagem) {
  let match = mensagem.conteudo.match(REGEX.anexo);
  if (match) {
    return {
      arquivo: match[1].trim(),
      tipo: 'anexo',
    };
  }

  if (mensagem.conteudo.includes('<Mídia oculta>') || mensagem.conteudo.includes('Mídia oculta')) {
    return {
      arquivo: null,
      tipo: 'oculta',
    };
  }

  return null;
}

// ============================================
// LÓGICA DE AGRUPAMENTO
// ============================================

function agruparBlocos(mensagens) {
  const blocos = [];
  let blocoAtual = null;

  function isLinhaVaziaDivisor(msg) {
    return msg.conteudo.trim() === '';
  }

  function criarNovoBloco(msg) {
    return {
      autor: msg.autor,
      primeiraData: msg.data,
      ultimaData: msg.data,
      midias: [],
      legendas: [],
      textos: [],
    };
  }

  function salvarBlocoAtual() {
    if (blocoAtual && blocoAtual.midias.length > 0) {
      blocos.push(blocoAtual);
    }
  }

  for (let i = 0; i < mensagens.length; i++) {
    const msg = mensagens[i];

    if (msg.conteudo === 'Mensagem apagada' || !msg.autor) {
      continue;
    }

    const midia = extrairMidia(msg);

    if (midia && midia.tipo === 'oculta') {
      adicionarAlerta('midia_oculta', `Mídia oculta: ${msg.dataStr} - ${msg.autor}`);
      continue;
    }

    if (isLinhaVaziaDivisor(msg)) {
      salvarBlocoAtual();
      blocoAtual = criarNovoBloco(msg);
      continue;
    }

    if (midia && midia.tipo === 'anexo') {
      const deveCriarNovoBloco = !blocoAtual ||
        blocoAtual.autor !== msg.autor ||
        diferencaMinutos(blocoAtual.ultimaData, msg.data) > CONFIG.toleranciaMinutos;

      if (deveCriarNovoBloco) {
        salvarBlocoAtual();
        blocoAtual = criarNovoBloco(msg);
      }

      blocoAtual.ultimaData = msg.data;
      blocoAtual.midias.push({
        arquivo: midia.arquivo,
        data: msg.data,
        dataStr: msg.dataStr,
      });

      for (const linha of msg.linhasContinuacao) {
        const numerico = extrairNumeroLegenda(linha);
        if (numerico) {
          blocoAtual.legendas.push(numerico);
        }
      }
    }
    else if (blocoAtual && msg.autor === blocoAtual.autor) {
      const diffTempo = diferencaMinutos(blocoAtual.ultimaData, msg.data);

      if (diffTempo <= CONFIG.toleranciaMinutos) {
        const numerico = extrairNumeroLegenda(msg.conteudo);
        if (numerico) {
          blocoAtual.legendas.push(numerico);
        }

        for (const linha of msg.linhasContinuacao) {
          const numLinha = extrairNumeroLegenda(linha);
          if (numLinha) {
            blocoAtual.legendas.push(numLinha);
          }
        }

        blocoAtual.ultimaData = msg.data;
      } else {
        salvarBlocoAtual();
        blocoAtual = null;
      }
    }
  }

  salvarBlocoAtual();

  return blocos;
}

// ============================================
// CÓPIA PARALELA DE ARQUIVOS
// ============================================

async function copiarArquivosParalelo(tarefas) {
  const resultados = { copiados: 0, erros: 0 };

  if (tarefas.length === 0) {
    return resultados;
  }

  for (let i = 0; i < tarefas.length; i += CONFIG.concorrencia) {
    const lote = tarefas.slice(i, i + CONFIG.concorrencia);

    await Promise.all(lote.map(async (tarefa) => {
      if (CONFIG.dryRun) {
        resultados.copiados++;
        return;
      }

      try {
        await copyFile(tarefa.origem, tarefa.destino);
        resultados.copiados++;
      } catch (err) {
        if (err.code === 'ENOENT') {
          adicionarAlerta('arquivo_nao_encontrado',
            `Arquivo não encontrado: ${tarefa.nomeOriginal} (${tarefa.dataStr} - ${tarefa.autor})`);
        } else {
          adicionarAlerta('arquivo_nao_encontrado',
            `Erro ao copiar ${tarefa.nomeOriginal}: ${err.message}`);
        }
        resultados.erros++;
      }
    }));

    const progresso = Math.min(i + CONFIG.concorrencia, tarefas.length);
    mostrarProgresso(progresso, tarefas.length, 'Copiando');
  }

  return resultados;
}

// ============================================
// PROCESSAMENTO - ORGANIZAÇÃO POR COLABORADOR
// ============================================

async function processarBlocos(blocos, outputBase) {
  // Agrupa blocos por colaborador e protocolo
  // Estrutura: { colaborador: { protocolo: [midias] } }
  const porColaborador = new Map();

  for (const bloco of blocos) {
    const autorSanitizado = sanitizarNomeAutor(bloco.autor);
    const legendasUnicas = [...new Set(bloco.legendas)];

    // Filtra apenas protocolos válidos (10 dígitos, começa com 2025 ou 2026)
    const protocolosValidos = legendasUnicas.filter(leg => isProtocoloValido(leg));
    const protocolosInvalidos = legendasUnicas.filter(leg => !isProtocoloValido(leg));

    // Alerta para protocolos inválidos
    for (const invalido of protocolosInvalidos) {
      adicionarAlerta('protocolo_invalido',
        `Protocolo "${invalido}" inválido (esperado 2025/2026 + 6 dígitos) - ${bloco.autor} - enviado para sem_legenda`);
    }

    // Determina o nome da pasta do protocolo
    let pastaProtocolo;
    if (protocolosValidos.length === 1) {
      pastaProtocolo = protocolosValidos[0];
    } else if (protocolosValidos.length > 1) {
      pastaProtocolo = protocolosValidos.join('_');
    } else if (protocolosInvalidos.length > 0) {
      // Tem legenda(s) inválida(s) - sem_legenda/{legendas}
      const nomePastaInvalida = protocolosInvalidos.join('_');
      pastaProtocolo = path.join('sem_legenda', nomePastaInvalida);
    } else {
      pastaProtocolo = 'sem_legenda';
    }

    if (!porColaborador.has(autorSanitizado)) {
      porColaborador.set(autorSanitizado, new Map());
    }

    const protocolosDoColaborador = porColaborador.get(autorSanitizado);

    if (!protocolosDoColaborador.has(pastaProtocolo)) {
      protocolosDoColaborador.set(pastaProtocolo, []);
    }

    // Adiciona mídias mantendo a ordem
    for (const midia of bloco.midias) {
      protocolosDoColaborador.get(pastaProtocolo).push({
        arquivo: midia.arquivo,
        data: midia.data,
        dataStr: midia.dataStr,
        autor: bloco.autor,
      });
    }
  }

  // Cria pastas e monta tarefas de cópia
  const tarefasCopia = [];

  for (const [colaborador, protocolos] of porColaborador) {
    for (const [protocolo, midias] of protocolos) {
      const pastaDestino = path.join(outputBase, colaborador, protocolo);

      if (!CONFIG.dryRun && !fs.existsSync(pastaDestino)) {
        fs.mkdirSync(pastaDestino, { recursive: true });
      }

      // Prefixo sequencial reinicia para cada pasta de protocolo
      let indiceSequencial = 1;

      for (const midia of midias) {
        const arquivoOrigem = path.join(CONFIG.inputDir, midia.arquivo);
        const timestamp = formatarTimestampArquivo(midia.data);
        const prefixo = String(indiceSequencial).padStart(2, '0');
        const nomeArquivo = `${prefixo}_${timestamp}_${midia.arquivo}`;
        const arquivoDestino = path.join(pastaDestino, nomeArquivo);

        tarefasCopia.push({
          origem: arquivoOrigem,
          destino: arquivoDestino,
          nomeOriginal: midia.arquivo,
          dataStr: midia.dataStr,
          autor: midia.autor,
        });

        indiceSequencial++;
      }
    }
  }

  console.log(`\n   ${tarefasCopia.length} arquivos para ${CONFIG.dryRun ? 'processar (dry-run)' : 'copiar'}...`);
  const resultados = await copiarArquivosParalelo(tarefasCopia);

  // Estatísticas por colaborador
  console.log('\n   Resumo por colaborador:');
  for (const [colaborador, protocolos] of porColaborador) {
    const totalMidias = [...protocolos.values()].reduce((sum, arr) => sum + arr.length, 0);
    const totalProtocolos = protocolos.size;
    console.log(`   - ${colaborador}: ${totalMidias} fotos em ${totalProtocolos} protocolo(s)`);
  }

  return {
    totalCopiados: resultados.copiados,
    totalNaoEncontrados: resultados.erros,
    totalColaboradores: porColaborador.size,
  };
}

// ============================================
// GERAÇÃO DE LOG
// ============================================

function gerarLog(stats, outputPath) {
  const timestamp = getTimestamp();
  const logPath = path.join(CONFIG.logsDir, `${timestamp}_feedback.txt`);

  if (!fs.existsSync(CONFIG.logsDir)) {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  }

  const conteudo = `
==========================================
RELATÓRIO FEEDBACK - Por Colaborador
==========================================
Data/Hora: ${new Date().toLocaleString('pt-BR')}
Output: ${outputPath}
Modo: ${CONFIG.dryRun ? 'DRY-RUN (simulação)' : 'EXECUÇÃO REAL'}

ESTATÍSTICAS:
- Total de blocos processados: ${stats.totalBlocos}
- Colaboradores: ${stats.totalColaboradores}
- Arquivos copiados: ${stats.totalCopiados}
- Arquivos não encontrados: ${stats.totalNaoEncontrados}

==========================================
ALERTAS (${alertas.length})
==========================================
${alertas.length > 0 ? alertas.join('\n') : 'Nenhum alerta.'}

==========================================
`;

  if (!CONFIG.dryRun) {
    fs.writeFileSync(logPath, conteudo.trim());
    console.log(`\n📄 Log salvo em: ${logPath}`);
  } else {
    console.log(`\n📄 [DRY-RUN] Log seria salvo em: ${logPath}`);
  }
}

// ============================================
// FUNÇÃO PRINCIPAL
// ============================================

async function main() {
  console.log('🚀 WhatsApp Feedbacker - Organização por Colaborador');

  if (CONFIG.dryRun) {
    console.log('⚠️  MODO DRY-RUN: nenhum arquivo será copiado\n');
  } else {
    console.log('');
  }

  if (!fs.existsSync(CONFIG.inputDir)) {
    console.error('❌ Pasta input/ não encontrada.');
    process.exit(1);
  }

  const arquivos = fs.readdirSync(CONFIG.inputDir);
  const arquivoTxt = arquivos.find(f => f.endsWith('.txt'));

  if (!arquivoTxt) {
    console.error('❌ Nenhum arquivo .txt encontrado em input/');
    process.exit(1);
  }

  console.log(`📖 Lendo: ${arquivoTxt}`);

  const conteudo = fs.readFileSync(path.join(CONFIG.inputDir, arquivoTxt), 'utf-8');
  const mensagens = parseChat(conteudo);
  console.log(`📝 ${mensagens.length} mensagens encontradas`);

  const blocos = agruparBlocos(mensagens);
  console.log(`📦 ${blocos.length} blocos de mídia identificados`);

  // Cria pasta output com data/hora da última mensagem do chat
  const ultimaMensagem = mensagens[mensagens.length - 1];
  const timestampChat = formatarTimestampArquivo(ultimaMensagem?.data);
  const outputPath = path.join(CONFIG.outputDir, `feedback-${timestampChat}`);

  if (!CONFIG.dryRun) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  console.log(`\n📂 ${CONFIG.dryRun ? '[DRY-RUN] Processando para' : 'Organizando por colaborador em'}: ${outputPath}`);
  const { totalCopiados, totalNaoEncontrados, totalColaboradores } = await processarBlocos(blocos, outputPath);

  const stats = {
    totalBlocos: blocos.length,
    totalCopiados,
    totalNaoEncontrados,
    totalColaboradores,
  };

  console.log(`\n✅ Concluído!`);
  console.log(`   - ${totalColaboradores} colaboradores`);
  console.log(`   - ${totalCopiados} arquivos ${CONFIG.dryRun ? 'seriam copiados' : 'copiados'}`);
  console.log(`   - ${totalNaoEncontrados} arquivos não encontrados`);
  console.log(`   - ${alertas.length} alertas gerados`);

  gerarLog(stats, outputPath);
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
