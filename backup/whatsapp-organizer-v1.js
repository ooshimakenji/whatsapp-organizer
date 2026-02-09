import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurações
const CONFIG = {
  inputDir: path.join(__dirname, 'input'),
  outputDir: path.join(__dirname, 'output'),
  logsDir: path.join(__dirname, 'logs'),
  toleranciaMinutos: 2,
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.mp4'],
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
  
  // Se for número de telefone, formata
  if (autor.startsWith('+')) {
    return autor.replace(/[+\s]/g, '').replace(/-/g, '-');
  }
  
  // Mantém emojis e caracteres especiais, só remove os problemáticos pra sistema de arquivos
  return autor.replace(/[<>:"/\\|?*]/g, '').trim();
}

function sanitizarLegendaTexto(texto) {
  if (!texto) return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')    // só letras, números, espaços e hífens
    .replace(/\s+/g, '-')            // espaços viram hífens
    .slice(0, 50)                    // limita tamanho
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

function ehLegendaNumerica(texto) {
  if (!texto) return false;
  const limpo = texto.trim();
  // Extrai só os números do início (ignora texto depois como "água normalizada")
  const match = limpo.match(/^(\d+)/);
  return match ? match[1] : null;
}

function extrairNumeroLegenda(texto) {
  if (!texto) return null;
  const match = texto.trim().match(/^(\d+)/);
  return match ? match[1] : null;
}

function adicionarAlerta(tipo, mensagem) {
  const icones = {
    'midia_oculta': '⚠️',
    'pasta_unida': '📁',
    'multiplas_legendas': '⚠️',
    'texto_ignorado': 'ℹ️',
    'arquivo_nao_encontrado': '❌',
    'info': '📋',
  };
  alertas.push(`${icones[tipo] || '•'} ${mensagem}`);
}

// ============================================
// PARSER DO CHAT
// ============================================

function parseChat(conteudo) {
  const linhas = conteudo.split('\n');
  const mensagens = [];
  
  // Regex para linha com timestamp: DD/MM/YYYY HH:MM - Autor: Mensagem
  const regexMensagem = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+-\s+([^:]+):\s*(.*)$/;
  
  let mensagemAtual = null;
  
  for (const linha of linhas) {
    const match = linha.match(regexMensagem);
    
    if (match) {
      // Nova mensagem
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
      // Linha de continuação
      mensagemAtual.linhasContinuacao.push(linha.trim());
    }
  }
  
  // Adiciona última mensagem
  if (mensagemAtual) {
    mensagens.push(mensagemAtual);
  }
  
  return mensagens;
}

function extrairMidia(mensagem) {
  // Padrões de mídia
  const regexAnexo = /‎?(.+\.(jpg|jpeg|png|mp4))\s*\(arquivo anexado\)/i;
  
  // Verifica conteúdo principal
  let match = mensagem.conteudo.match(regexAnexo);
  if (match) {
    return {
      arquivo: match[1].trim(),
      tipo: 'anexo',
    };
  }
  
  // Verifica mídia oculta
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
  
  for (let i = 0; i < mensagens.length; i++) {
    const msg = mensagens[i];
    
    // Ignora mensagens apagadas e de sistema
    if (msg.conteudo === 'Mensagem apagada' || !msg.autor) {
      continue;
    }
    
    const midia = extrairMidia(msg);
    
    // Se é mídia oculta, alerta e continua
    if (midia && midia.tipo === 'oculta') {
      adicionarAlerta('midia_oculta', `Mídia oculta: ${msg.dataStr} - ${msg.autor}`);
      continue;
    }
    
    // Se é mídia válida
    if (midia && midia.tipo === 'anexo') {
      const deveCriarNovoBloco = !blocoAtual ||
        blocoAtual.autor !== msg.autor ||
        diferencaMinutos(blocoAtual.ultimaData, msg.data) > CONFIG.toleranciaMinutos;
      
      if (deveCriarNovoBloco) {
        if (blocoAtual) {
          blocos.push(blocoAtual);
        }
        blocoAtual = {
          autor: msg.autor,
          primeiraData: msg.data,
          ultimaData: msg.data,
          midias: [],
          legendas: [],
          textos: [],
        };
      }
      
      blocoAtual.ultimaData = msg.data;
      blocoAtual.midias.push({
        arquivo: midia.arquivo,
        data: msg.data,
        dataStr: msg.dataStr,
      });
      
      // Processa linhas de continuação como possíveis legendas
      for (const linha of msg.linhasContinuacao) {
        const numerico = extrairNumeroLegenda(linha);
        if (numerico) {
          blocoAtual.legendas.push(numerico);
          // Se tem texto após o número, registra
          const textoApos = linha.replace(/^\d+\s*/, '').trim();
          if (textoApos) {
            blocoAtual.textos.push(textoApos);
          }
        } else if (linha && !linha.includes('Mensagem apagada')) {
          blocoAtual.textos.push(linha);
        }
      }
    }
    // Se não é mídia mas pode ser legenda de bloco atual
    else if (blocoAtual && msg.autor === blocoAtual.autor) {
      const diffTempo = diferencaMinutos(blocoAtual.ultimaData, msg.data);
      
      if (diffTempo <= CONFIG.toleranciaMinutos) {
        // Pode ser legenda
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
        
        // Também processa linhas de continuação
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
        // Tempo passou muito, fecha bloco
        blocos.push(blocoAtual);
        blocoAtual = null;
      }
    }
  }
  
  // Adiciona último bloco
  if (blocoAtual && blocoAtual.midias.length > 0) {
    blocos.push(blocoAtual);
  }
  
  return blocos;
}

// ============================================
// PROCESSAMENTO E CÓPIA DE ARQUIVOS
// ============================================

function processarBlocos(blocos, outputBase) {
  const pastasUsadas = new Map(); // Para detectar pastas unidas
  let totalCopiados = 0;
  let totalNaoEncontrados = 0;
  
  for (const bloco of blocos) {
    // Remove duplicatas de legendas
    const legendasUnicas = [...new Set(bloco.legendas)];
    
    let pastaDestino;
    let tipoBloco;
    
    if (legendasUnicas.length === 1) {
      // Uma legenda numérica - caso ideal
      pastaDestino = path.join(outputBase, legendasUnicas[0]);
      tipoBloco = 'legenda_numerica';
      
      // Verifica se pasta já foi usada
      if (pastasUsadas.has(legendasUnicas[0])) {
        adicionarAlerta('pasta_unida', `Pasta ${legendasUnicas[0]} recebeu arquivos de múltiplos blocos`);
      }
      pastasUsadas.set(legendasUnicas[0], true);
      
    } else if (legendasUnicas.length > 1) {
      // Múltiplas legendas - anomalia
      const nomePasta = legendasUnicas.join('_');
      pastaDestino = path.join(outputBase, 'sem_legenda', sanitizarNomeAutor(bloco.autor), nomePasta);
      tipoBloco = 'multiplas_legendas';
      adicionarAlerta('multiplas_legendas', `Bloco com ${legendasUnicas.length} legendas (${legendasUnicas.join(', ')}) - ${bloco.autor} - verificar manualmente`);
      
    } else {
      // Sem legenda numérica
      pastaDestino = path.join(outputBase, 'sem_legenda', sanitizarNomeAutor(bloco.autor));
      tipoBloco = 'sem_legenda';
    }
    
    // Alerta textos ignorados em blocos com legenda numérica
    if (tipoBloco === 'legenda_numerica' && bloco.textos.length > 0) {
      for (const texto of bloco.textos) {
        adicionarAlerta('texto_ignorado', `Texto "${texto.slice(0, 50)}" ignorado no bloco ${legendasUnicas[0]}`);
      }
    }
    
    // Cria pasta se não existe
    if (!fs.existsSync(pastaDestino)) {
      fs.mkdirSync(pastaDestino, { recursive: true });
    }
    
    // Copia cada mídia
    for (const midia of bloco.midias) {
      const arquivoOrigem = path.join(CONFIG.inputDir, midia.arquivo);
      
      if (!fs.existsSync(arquivoOrigem)) {
        adicionarAlerta('arquivo_nao_encontrado', `Arquivo não encontrado: ${midia.arquivo} (${midia.dataStr} - ${bloco.autor})`);
        totalNaoEncontrados++;
        continue;
      }
      
      // Monta nome do arquivo
      const timestamp = formatarTimestampArquivo(midia.data);
      const autorSanitizado = sanitizarNomeAutor(bloco.autor);
      let nomeArquivo;
      
      if (tipoBloco === 'legenda_numerica') {
        // Com legenda numérica: timestamp_autor_arquivo
        nomeArquivo = `${timestamp}_${autorSanitizado}_${midia.arquivo}`;
      } else if (tipoBloco === 'sem_legenda' && bloco.textos.length > 0) {
        // Sem legenda numérica mas tem texto: timestamp_texto_arquivo
        const textoSanitizado = sanitizarLegendaTexto(bloco.textos[0]);
        nomeArquivo = `${timestamp}_${textoSanitizado}_${midia.arquivo}`;
      } else {
        // Sem nada: timestamp_arquivo
        nomeArquivo = `${timestamp}_${midia.arquivo}`;
      }
      
      const arquivoDestino = path.join(pastaDestino, nomeArquivo);
      
      // Copia arquivo
      try {
        fs.copyFileSync(arquivoOrigem, arquivoDestino);
        totalCopiados++;
      } catch (err) {
        adicionarAlerta('arquivo_nao_encontrado', `Erro ao copiar ${midia.arquivo}: ${err.message}`);
      }
    }
  }
  
  return { totalCopiados, totalNaoEncontrados };
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

  fs.writeFileSync(logPath, conteudo.trim());
  console.log(`\n📄 Log salvo em: ${logPath}`);
}

// ============================================
// FUNÇÃO PRINCIPAL
// ============================================

async function main() {
  console.log('🚀 WhatsApp Organizer iniciado...\n');
  
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
  
  // Cria pasta output com timestamp
  const timestamp = getTimestamp();
  const outputPath = path.join(CONFIG.outputDir, `fotos-organizadas-${timestamp}`);
  fs.mkdirSync(outputPath, { recursive: true });
  
  // Processa e copia
  console.log(`\n📂 Copiando arquivos para: ${outputPath}`);
  const { totalCopiados, totalNaoEncontrados } = processarBlocos(blocos, outputPath);
  
  // Estatísticas finais
  const stats = {
    totalBlocos: blocos.length,
    totalCopiados,
    totalNaoEncontrados,
  };
  
  console.log(`\n✅ Concluído!`);
  console.log(`   - ${totalCopiados} arquivos copiados`);
  console.log(`   - ${totalNaoEncontrados} arquivos não encontrados`);
  console.log(`   - ${alertas.length} alertas gerados`);
  
  // Gera log
  gerarLog(stats, outputPath);
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
