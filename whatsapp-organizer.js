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
  toleranciaMinutos: 2,
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
  // Novas configs
  concorrencia: 10, // arquivos copiados em paralelo
  dryRun: process.argv.includes('--dry-run'),
};

// Regex compilado uma vez só
const REGEX = {
  mensagem: /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+-\s+([^:]+):\s*(.*)$/,
  anexo: /‎?(.+\.(jpg|jpeg|png|mp4))\s*\(arquivo anexado\)/i,
  numeroLegenda: /^(\d+)/,
  // Protocolo válido: 10 dígitos começando com 2025 ou 2026
  protocoloValido: /^(202[56]\d{6})$/,
};

// Extensões de foto para verificação de mínimo por pasta
const EXTENSOES_FOTO = ['.jpg', '.jpeg', '.png', '.webp'];

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

function sanitizarLegendaTexto(texto) {
  if (!texto) return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .trim();
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
    'pasta_unida': '📁',
    'multiplas_legendas': '📂',
    'texto_ignorado': 'ℹ️',
    'arquivo_nao_encontrado': '❌',
    'protocolo_invalido': '🔢',
    'poucas_fotos': '📷',
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
    console.log(); // quebra linha no final
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

  // Detecta linha vazia do autor (divisor de bloco)
  function isLinhaVaziaDivisor(msg) {
    return msg.conteudo.trim() === '';
  }

  // Cria novo bloco para o autor
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

  // Salva bloco atual se tiver mídias
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

    // REGRA NOVA: Linha vazia do autor = divisor de bloco
    if (isLinhaVaziaDivisor(msg)) {
      salvarBlocoAtual();
      blocoAtual = criarNovoBloco(msg);
      continue;
    }

    if (midia && midia.tipo === 'anexo') {
      // Se não tem bloco ou autor diferente ou tempo excedido, cria novo
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

      // Processa linhas de continuação (legendas após a mídia)
      for (const linha of msg.linhasContinuacao) {
        const numerico = extrairNumeroLegenda(linha);
        if (numerico) {
          blocoAtual.legendas.push(numerico);
          const textoApos = linha.replace(/^\d+\s*/, '').trim();
          if (textoApos) {
            blocoAtual.textos.push(textoApos);
          }
        } else if (linha && !linha.includes('Mensagem apagada')) {
          blocoAtual.textos.push(linha);
        }
      }
    }
    // Mensagem de texto (não mídia) do mesmo autor dentro da tolerância
    else if (blocoAtual && msg.autor === blocoAtual.autor) {
      const diffTempo = diferencaMinutos(blocoAtual.ultimaData, msg.data);

      if (diffTempo <= CONFIG.toleranciaMinutos) {
        const numerico = extrairNumeroLegenda(msg.conteudo);
        if (numerico) {
          blocoAtual.legendas.push(numerico);
          const textoApos = msg.conteudo.replace(/^\d+\s*/, '').trim();
          if (textoApos) {
            blocoAtual.textos.push(textoApos);
          }
        } else if (msg.conteudo && !msg.conteudo.includes('Mensagem apagada')) {
          blocoAtual.textos.push(msg.conteudo);
        }

        for (const linha of msg.linhasContinuacao) {
          const numLinha = extrairNumeroLegenda(linha);
          if (numLinha) {
            blocoAtual.legendas.push(numLinha);
          } else if (linha) {
            blocoAtual.textos.push(linha);
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
        // Dry run: só simula
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
    
    // Atualiza progresso
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
  const fotosPorProtocolo = new Map();
  
  // Primeira passada: prepara pastas e lista de cópias
  for (const bloco of blocos) {
    const legendasUnicas = [...new Set(bloco.legendas)];

    // Filtra apenas protocolos válidos (10 dígitos, começa com 2025 ou 2026)
    const protocolosValidos = legendasUnicas.filter(leg => isProtocoloValido(leg));
    const protocolosInvalidos = legendasUnicas.filter(leg => !isProtocoloValido(leg));

    // Alerta para protocolos inválidos
    for (const invalido of protocolosInvalidos) {
      adicionarAlerta('protocolo_invalido',
        `Protocolo "${invalido}" inválido (esperado 2025/2026 + 6 dígitos) - ${bloco.autor} - enviado para sem_legenda`);
    }

    let pastaDestino;
    let tipoBloco;

    if (protocolosValidos.length === 1) {
      // Uma legenda numérica válida - caso ideal
      pastaDestino = path.join(outputBase, protocolosValidos[0]);
      tipoBloco = 'legenda_numerica';

      if (pastasUsadas.has(protocolosValidos[0])) {
        adicionarAlerta('pasta_unida', `Pasta ${protocolosValidos[0]} recebeu arquivos de múltiplos blocos`);
      }
      pastasUsadas.set(protocolosValidos[0], true);

    } else if (protocolosValidos.length > 1) {
      // MÚLTIPLAS LEGENDAS VÁLIDAS - dentro de sem_legenda/{autor}/{legendas}/
      const nomePasta = protocolosValidos.join('_');
      const autorSanitizado = sanitizarNomeAutor(bloco.autor);
      pastaDestino = path.join(outputBase, 'sem_legenda', autorSanitizado, nomePasta);
      tipoBloco = 'multiplas_legendas';

      // Cria subpastas vazias para cada protocolo
      if (!CONFIG.dryRun) {
        for (const legenda of protocolosValidos) {
          const subpasta = path.join(pastaDestino, legenda);
          if (!fs.existsSync(subpasta)) {
            fs.mkdirSync(subpasta, { recursive: true });
          }
        }
      }

      adicionarAlerta('multiplas_legendas',
        `Bloco com ${protocolosValidos.length} legendas (${protocolosValidos.join(', ')}) - ${bloco.autor} - subpastas criadas`);

    } else if (protocolosInvalidos.length > 0) {
      // Tem protocolo(s) inválido(s) - sem_legenda/{autor}/{legendas_invalidas}
      const nomePasta = protocolosInvalidos.join('_');
      pastaDestino = path.join(outputBase, 'sem_legenda', sanitizarNomeAutor(bloco.autor), nomePasta);
      tipoBloco = 'sem_legenda';
    } else {
      // Sem legenda nenhuma - direto na pasta do autor
      pastaDestino = path.join(outputBase, 'sem_legenda', sanitizarNomeAutor(bloco.autor));
      tipoBloco = 'sem_legenda';
    }
    
    // Alerta textos ignorados em blocos com legenda numérica válida
    if (tipoBloco === 'legenda_numerica' && bloco.textos.length > 0) {
      for (const texto of bloco.textos) {
        adicionarAlerta('texto_ignorado', `Texto "${texto.slice(0, 50)}" ignorado no bloco ${protocolosValidos[0]}`);
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

      // Monta nome do arquivo
      const timestamp = formatarTimestampArquivo(midia.data);
      const autorSanitizado = sanitizarNomeAutor(bloco.autor);
      let nomeArquivo;

      if (tipoBloco === 'legenda_numerica') {
        nomeArquivo = `${timestamp}_${autorSanitizado}_${midia.arquivo}`;
      } else if (tipoBloco === 'multiplas_legendas') {
        // Prefixo sequencial para manter ordem do WhatsApp ao ordenar por nome
        const prefixo = String(indiceSequencial).padStart(2, '0');
        nomeArquivo = `${prefixo}_${timestamp}_${midia.arquivo}`;
        indiceSequencial++;
      } else if (tipoBloco === 'sem_legenda' && bloco.textos.length > 0) {
        const textoSanitizado = sanitizarLegendaTexto(bloco.textos[0]);
        nomeArquivo = `${timestamp}_${textoSanitizado}_${midia.arquivo}`;
      } else {
        nomeArquivo = `${timestamp}_${midia.arquivo}`;
      }

      const arquivoDestino = path.join(pastaDestino, nomeArquivo);
      
      tarefasCopia.push({
        origem: arquivoOrigem,
        destino: arquivoDestino,
        nomeOriginal: midia.arquivo,
        dataStr: midia.dataStr,
        autor: bloco.autor,
      });
    }

    // Conta fotos por protocolo válido (para verificação de mínimo)
    if (tipoBloco === 'legenda_numerica') {
      const protocolo = protocolosValidos[0];
      const qtdFotos = bloco.midias.filter(m => {
        const ext = path.extname(m.arquivo).toLowerCase();
        return EXTENSOES_FOTO.includes(ext);
      }).length;
      fotosPorProtocolo.set(protocolo, (fotosPorProtocolo.get(protocolo) || 0) + qtdFotos);
    }
  }
  
  // Verifica pastas de protocolo com menos de 3 fotos
  for (const [protocolo, qtdFotos] of fotosPorProtocolo) {
    if (qtdFotos < 3) {
      adicionarAlerta('poucas_fotos', `Pasta ${protocolo} tem apenas ${qtdFotos} foto(s) (mínimo esperado: 3)`);
    }
  }

  // Segunda passada: copia em paralelo
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
  const logPath = path.join(CONFIG.logsDir, `${timestamp}_relatorio.txt`);
  
  if (!fs.existsSync(CONFIG.logsDir)) {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  }
  
  const conteudo = `
==========================================
RELATÓRIO DE ORGANIZAÇÃO - WhatsApp
==========================================
Data/Hora: ${new Date().toLocaleString('pt-BR')}
Output: ${outputPath}
Modo: ${CONFIG.dryRun ? 'DRY-RUN (simulação)' : 'EXECUÇÃO REAL'}

ESTATÍSTICAS:
- Total de blocos processados: ${stats.totalBlocos}
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
  console.log('🚀 WhatsApp Organizer v2 iniciado...');
  
  if (CONFIG.dryRun) {
    console.log('⚠️  MODO DRY-RUN: nenhum arquivo será copiado\n');
  } else {
    console.log('');
  }
  
  // Verifica se pasta input existe
  if (!fs.existsSync(CONFIG.inputDir)) {
    console.error('❌ Pasta input/ não encontrada. Crie a pasta e coloque o _chat.txt e as mídias.');
    process.exit(1);
  }
  
  // Encontra arquivo .txt
  const arquivos = fs.readdirSync(CONFIG.inputDir);
  const arquivoTxt = arquivos.find(f => f.endsWith('.txt'));
  
  if (!arquivoTxt) {
    console.error('❌ Nenhum arquivo .txt encontrado em input/');
    process.exit(1);
  }
  
  console.log(`📖 Lendo: ${arquivoTxt}`);
  
  // Lê e parseia o chat
  const conteudo = fs.readFileSync(path.join(CONFIG.inputDir, arquivoTxt), 'utf-8');
  const mensagens = parseChat(conteudo);
  console.log(`📝 ${mensagens.length} mensagens encontradas`);
  
  // Agrupa em blocos
  const blocos = agruparBlocos(mensagens);
  console.log(`📦 ${blocos.length} blocos de mídia identificados`);
  
  // Cria pasta output com data/hora da última mensagem do chat
  const ultimaMensagem = mensagens[mensagens.length - 1];
  const timestampChat = formatarTimestampArquivo(ultimaMensagem?.data);
  const outputPath = path.join(CONFIG.outputDir, `fotos-${timestampChat}`);
  
  if (!CONFIG.dryRun) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  
  // Processa e copia
  console.log(`\n📂 ${CONFIG.dryRun ? '[DRY-RUN] Processando para' : 'Copiando arquivos para'}: ${outputPath}`);
  const { totalCopiados, totalNaoEncontrados } = await processarBlocos(blocos, outputPath);
  
  // Estatísticas finais
  const stats = {
    totalBlocos: blocos.length,
    totalCopiados,
    totalNaoEncontrados,
  };
  
  console.log(`\n✅ Concluído!`);
  console.log(`   - ${totalCopiados} arquivos ${CONFIG.dryRun ? 'seriam copiados' : 'copiados'}`);
  console.log(`   - ${totalNaoEncontrados} arquivos não encontrados`);
  console.log(`   - ${alertas.length} alertas gerados`);
  
  // Gera log
  gerarLog(stats, outputPath);
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});