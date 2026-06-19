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
  outputDir: path.join(__dirname, 'output'),
  logsDir: path.join(__dirname, 'logs'),
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
  concorrencia: 10,
  dryRun: process.argv.includes('--dry-run'),
  // Threshold para alerta de junção (em minutos)
  alertaIntervaloMinutos: 30,
};

// Regex compilado
const REGEX = {
  mensagem: /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+-\s+([^:]+):\s*(.*)$/,
  anexo: /‎?(.+\.(jpg|jpeg|png|mp4))\s*\(arquivo anexado\)/i,
  // OS: número de 10 dígitos começando com 20XX (antes era fixo em 2025/2026 e quebraria em 2027)
  numeroOS: /\b(20\d{8})\b/,
  // Qualquer sequência numérica no início do texto (para capturar legendas inválidas)
  numeroLegenda: /^(\d+)/,
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
  if (!data1 || !data2) return 0;
  const d1 = new Date(data1);
  const d2 = new Date(data2);
  return Math.abs(d1 - d2) / (1000 * 60);
}

function extrairNumeroOS(texto) {
  if (!texto) return null;
  const match = texto.match(REGEX.numeroOS);
  return match ? match[1] : null;
}

function adicionarAlerta(tipo, mensagem) {
  const icones = {
    'midia_oculta': '⚠️',
    'pasta_unida': '📁',
    'intervalo_grande': '⏰',
    'sem_os': '❓',
    'arquivo_nao_encontrado': '❌',
    'info': '📋',
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
// LÓGICA DE AGRUPAMENTO - BATEDOR
// ============================================

function agruparBlocosBatedor(mensagens) {
  const blocos = [];
  let blocoAtual = null;

  function isLinhaVazia(msg) {
    return msg.conteudo.trim() === '';
  }

  function criarNovoBloco(msg) {
    return {
      autor: msg.autor,
      primeiraData: msg.data,
      ultimaData: msg.data,
      midias: [],
      numeroOS: null,
      legendasInvalidas: [],
      textos: [],
    };
  }

  function salvarBlocoAtual() {
    if (blocoAtual && blocoAtual.midias.length > 0) {
      blocos.push(blocoAtual);
    }
  }

  // Verifica intervalo e gera alerta se necessário
  function verificarIntervalo(blocoAtual, novaData) {
    if (!blocoAtual || !blocoAtual.ultimaData) return;

    const intervalo = diferencaMinutos(blocoAtual.ultimaData, novaData);
    if (intervalo > CONFIG.alertaIntervaloMinutos) {
      const horas = Math.floor(intervalo / 60);
      const mins = Math.round(intervalo % 60);
      const tempoStr = horas > 0 ? `${horas}h${mins}min` : `${mins}min`;
      adicionarAlerta('intervalo_grande',
        `Bloco OS ${blocoAtual.numeroOS || 'sem-os'} (${blocoAtual.autor}): intervalo de ${tempoStr} entre mídias`);
    }
  }

  // Procura OS em texto
  function procurarOS(texto) {
    return extrairNumeroOS(texto);
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

    // REGRA 1: Linha vazia do autor = início de novo bloco
    if (isLinhaVazia(msg)) {
      salvarBlocoAtual();
      blocoAtual = criarNovoBloco(msg);
      continue;
    }

    // REGRA 2: Mudança de autor = novo bloco
    if (blocoAtual && blocoAtual.autor !== msg.autor) {
      salvarBlocoAtual();
      blocoAtual = null;
    }

    if (midia && midia.tipo === 'anexo') {
      // Se não tem bloco, cria um novo
      if (!blocoAtual) {
        blocoAtual = criarNovoBloco(msg);
      }

      // Verifica intervalo grande
      verificarIntervalo(blocoAtual, msg.data);

      blocoAtual.ultimaData = msg.data;
      blocoAtual.midias.push({
        arquivo: midia.arquivo,
        data: msg.data,
        dataStr: msg.dataStr,
      });

      // Procura OS nas linhas de continuação
      for (const linha of msg.linhasContinuacao) {
        const os = procurarOS(linha);
        if (os) {
          blocoAtual.numeroOS = os;
        } else {
          // Captura número inválido (não é OS válida)
          const numMatch = linha.trim().match(REGEX.numeroLegenda);
          if (numMatch && !REGEX.numeroOS.test(numMatch[1])) {
            blocoAtual.legendasInvalidas.push(numMatch[1]);
          }
        }
      }
    }
    // Mensagem de texto (não mídia)
    else if (blocoAtual && msg.autor === blocoAtual.autor) {
      // Procura OS no conteúdo
      const os = procurarOS(msg.conteudo);
      if (os) {
        blocoAtual.numeroOS = os;
      } else {
        // Captura número inválido
        const numMatch = msg.conteudo.trim().match(REGEX.numeroLegenda);
        if (numMatch && !REGEX.numeroOS.test(numMatch[1])) {
          blocoAtual.legendasInvalidas.push(numMatch[1]);
        }
      }

      // Procura OS nas linhas de continuação
      for (const linha of msg.linhasContinuacao) {
        const osLinha = procurarOS(linha);
        if (osLinha) {
          blocoAtual.numeroOS = osLinha;
        } else {
          const numMatch = linha.trim().match(REGEX.numeroLegenda);
          if (numMatch && !REGEX.numeroOS.test(numMatch[1])) {
            blocoAtual.legendasInvalidas.push(numMatch[1]);
          }
        }
      }

      blocoAtual.ultimaData = msg.data;
    }
    // Texto de outro autor com OS = pode ser referência ao mesmo serviço
    else if (!blocoAtual) {
      const os = procurarOS(msg.conteudo);
      if (os) {
        // Cria bloco novo com essa OS
        blocoAtual = criarNovoBloco(msg);
        blocoAtual.numeroOS = os;
      }
    }
  }

  salvarBlocoAtual();

  // REGRA 3: Agrupa blocos com mesma OS
  return agruparPorOS(blocos);
}

// Agrupa blocos que têm a mesma OS
function agruparPorOS(blocos) {
  const blocosAgrupados = [];
  const osMapa = new Map(); // OS -> índice no blocosAgrupados

  for (const bloco of blocos) {
    if (bloco.numeroOS && osMapa.has(bloco.numeroOS)) {
      // Junta ao bloco existente com mesma OS
      const idx = osMapa.get(bloco.numeroOS);
      const blocoExistente = blocosAgrupados[idx];

      // Verifica intervalo entre blocos
      const intervalo = diferencaMinutos(blocoExistente.ultimaData, bloco.primeiraData);
      if (intervalo > CONFIG.alertaIntervaloMinutos) {
        const horas = Math.floor(intervalo / 60);
        const mins = Math.round(intervalo % 60);
        const tempoStr = horas > 0 ? `${horas}h${mins}min` : `${mins}min`;
        adicionarAlerta('intervalo_grande',
          `OS ${bloco.numeroOS}: blocos separados por ${tempoStr} foram unidos (autores: ${blocoExistente.autor}, ${bloco.autor})`);
      }

      // Merge mídias e legendas inválidas
      blocoExistente.midias.push(...bloco.midias);
      blocoExistente.legendasInvalidas.push(...(bloco.legendasInvalidas || []));
      blocoExistente.ultimaData = bloco.ultimaData;

      // Atualiza autor se diferente (mantém o primeiro)
      if (blocoExistente.autor !== bloco.autor) {
        blocoExistente.autoresExtras = blocoExistente.autoresExtras || [];
        if (!blocoExistente.autoresExtras.includes(bloco.autor)) {
          blocoExistente.autoresExtras.push(bloco.autor);
        }
      }
    } else {
      // Novo bloco
      const idx = blocosAgrupados.length;
      blocosAgrupados.push(bloco);
      if (bloco.numeroOS) {
        osMapa.set(bloco.numeroOS, idx);
      }
    }
  }

  return blocosAgrupados;
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
// PROCESSAMENTO DE BLOCOS
// ============================================

async function processarBlocos(blocos, outputBase) {
  const pastasUsadas = new Map();
  const tarefasCopia = [];

  for (const bloco of blocos) {
    let pastaDestino;

    if (bloco.numeroOS) {
      // Tem OS - vai para pasta da OS
      pastaDestino = path.join(outputBase, bloco.numeroOS);

      if (pastasUsadas.has(bloco.numeroOS)) {
        adicionarAlerta('pasta_unida', `Pasta ${bloco.numeroOS} recebeu arquivos de múltiplos blocos`);
      }
      pastasUsadas.set(bloco.numeroOS, true);

    } else {
      // Sem OS válida
      const legendasInvalidas = [...new Set(bloco.legendasInvalidas || [])];
      const autorSanitizado = sanitizarNomeAutor(bloco.autor);

      if (legendasInvalidas.length > 0) {
        // Tem legenda(s) inválida(s) - sem_legenda/{autor}/{legendas}
        const nomePasta = legendasInvalidas.join('_');
        pastaDestino = path.join(outputBase, 'sem_legenda', autorSanitizado, nomePasta);
        adicionarAlerta('sem_os', `Bloco com legenda inválida (${legendasInvalidas.join(', ')}): ${bloco.autor} - ${bloco.primeiraData.toLocaleString('pt-BR')} (${bloco.midias.length} mídias)`);
      } else {
        // Sem legenda nenhuma - sem_legenda/{autor}
        pastaDestino = path.join(outputBase, 'sem_legenda', autorSanitizado);
        adicionarAlerta('sem_os', `Bloco sem OS: ${bloco.autor} - ${bloco.primeiraData.toLocaleString('pt-BR')} (${bloco.midias.length} mídias)`);
      }
    }

    // Cria pasta se não existe
    if (!CONFIG.dryRun && !fs.existsSync(pastaDestino)) {
      fs.mkdirSync(pastaDestino, { recursive: true });
    }

    // Monta tarefas de cópia
    let indiceSequencial = 1;
    for (const midia of bloco.midias) {
      const arquivoOrigem = path.join(CONFIG.inputDir, midia.arquivo);

      const timestamp = formatarTimestampArquivo(midia.data);
      const autorSanitizado = sanitizarNomeAutor(bloco.autor);

      // Prefixo sequencial para manter ordem
      const prefixo = String(indiceSequencial).padStart(2, '0');
      const nomeArquivo = `${prefixo}_${timestamp}_${autorSanitizado}_${midia.arquivo}`;
      indiceSequencial++;

      const arquivoDestino = path.join(pastaDestino, nomeArquivo);

      tarefasCopia.push({
        origem: arquivoOrigem,
        destino: arquivoDestino,
        nomeOriginal: midia.arquivo,
        dataStr: midia.dataStr,
        autor: bloco.autor,
      });
    }
  }

  console.log(`\n   ${tarefasCopia.length} arquivos para ${CONFIG.dryRun ? 'processar (dry-run)' : 'copiar'}...`);
  const resultados = await copiarArquivosParalelo(tarefasCopia);

  return {
    totalCopiados: resultados.copiados,
    totalNaoEncontrados: resultados.erros,
  };
}

// ============================================
// GERAÇÃO DE LOG
// ============================================

function gerarLog(stats, outputPath) {
  const timestamp = getTimestamp();
  const logPath = path.join(CONFIG.logsDir, `${timestamp}_batedor_relatorio.txt`);

  if (!fs.existsSync(CONFIG.logsDir)) {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  }

  // Separa alertas por tipo
  const alertasIntervalo = alertas.filter(a => a.includes('⏰'));
  const alertasSemOS = alertas.filter(a => a.includes('❓'));
  const alertasOutros = alertas.filter(a => !a.includes('⏰') && !a.includes('❓'));

  const conteudo = `
==========================================
RELATÓRIO DE ORGANIZAÇÃO - WhatsApp BATEDOR
==========================================
Data/Hora: ${new Date().toLocaleString('pt-BR')}
Output: ${outputPath}
Modo: ${CONFIG.dryRun ? 'DRY-RUN (simulação)' : 'EXECUÇÃO REAL'}

ESTATÍSTICAS:
- Total de blocos processados: ${stats.totalBlocos}
- Arquivos copiados: ${stats.totalCopiados}
- Arquivos não encontrados: ${stats.totalNaoEncontrados}

==========================================
ALERTAS DE INTERVALO GRANDE (${alertasIntervalo.length})
==========================================
${alertasIntervalo.length > 0 ? alertasIntervalo.join('\n') : 'Nenhum.'}

==========================================
BLOCOS SEM OS (${alertasSemOS.length})
==========================================
${alertasSemOS.length > 0 ? alertasSemOS.join('\n') : 'Nenhum.'}

==========================================
OUTROS ALERTAS (${alertasOutros.length})
==========================================
${alertasOutros.length > 0 ? alertasOutros.join('\n') : 'Nenhum.'}

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
  console.log('🚀 WhatsApp Organizer BATEDOR iniciado...');
  console.log('   Lógica: Linha vazia separa | Mesma OS agrupa | Alerta se intervalo > 30min\n');

  if (CONFIG.dryRun) {
    console.log('⚠️  MODO DRY-RUN: nenhum arquivo será copiado\n');
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

  // Agrupa com lógica do batedor
  const blocos = agruparBlocosBatedor(mensagens);
  console.log(`📦 ${blocos.length} blocos de mídia identificados`);

  // Estatísticas de OS
  const blocosComOS = blocos.filter(b => b.numeroOS).length;
  const blocosSemOS = blocos.filter(b => !b.numeroOS).length;
  console.log(`   - ${blocosComOS} blocos com OS`);
  console.log(`   - ${blocosSemOS} blocos sem OS`);

  // Cria pasta output com data/hora da última mensagem do chat
  const ultimaMensagem = mensagens[mensagens.length - 1];
  const timestampChat = formatarTimestampArquivo(ultimaMensagem?.data);
  const outputPath = path.join(CONFIG.outputDir, `batedor-${timestampChat}`);

  if (!CONFIG.dryRun) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  console.log(`\n📂 ${CONFIG.dryRun ? '[DRY-RUN] Processando para' : 'Copiando arquivos para'}: ${outputPath}`);
  const { totalCopiados, totalNaoEncontrados } = await processarBlocos(blocos, outputPath);

  const stats = {
    totalBlocos: blocos.length,
    totalCopiados,
    totalNaoEncontrados,
  };

  console.log(`\n✅ Concluído!`);
  console.log(`   - ${totalCopiados} arquivos ${CONFIG.dryRun ? 'seriam copiados' : 'copiados'}`);
  console.log(`   - ${totalNaoEncontrados} arquivos não encontrados`);
  console.log(`   - ${alertas.length} alertas gerados`);

  gerarLog(stats, outputPath);
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
