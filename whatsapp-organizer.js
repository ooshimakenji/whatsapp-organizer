import fs from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
  // Extensões reconhecidas como mídia anexada. Também alimentam o regex de anexo
  // (antes as extensões estavam fixas só dentro do regex e o CONFIG era ignorado).
  extensoesValidas: ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.3gp'],
  // Protocolo = 10 dígitos começando com um ano (20XX) >= anoMinimoProtocolo.
  // Antes era fixo em 2025/2026 e quebraria a partir de 2027; agora aceita anos futuros.
  anoMinimoProtocolo: 2025,
  // Herança de protocolo para fotos SEM legenda (desligado por padrão — risco de pasta errada).
  // Quando true, foto sem legenda herda o último protocolo do mesmo autor dentro da janela abaixo.
  herdarProtocolo: process.argv.includes('--herdar'),
  janelaHerancaMinutos: 5,
  // Novas configs
  concorrencia: 10, // arquivos copiados em paralelo
  dryRun: process.argv.includes('--dry-run'),
};

// Classe de espaços que o WhatsApp pode inserir (espaço normal, no-break e narrow no-break)
const ESP = '[\\s\\u202f\\u00a0]';

// Alternância de extensões derivada do CONFIG (ex.: "jpg|jpeg|png|webp|mp4|mov|3gp")
const EXT_ALT = CONFIG.extensoesValidas
  .map(e => e.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// Regex compilado uma vez só
const REGEX = {
  // Cabeçalho de mensagem. Aceita ano de 2 ou 4 dígitos, vírgula opcional após a data,
  // segundos opcionais, AM/PM opcional e os espaços especiais do WhatsApp.
  // Grupos: 1=dia 2=mes 3=ano 4=hora 5=min 6=seg? 7=ampm? 8=autor 9=conteudo
  mensagem: new RegExp(
    `^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4}),?${ESP}+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?${ESP}*([APap][Mm])?${ESP}*-${ESP}+([^:]+):${ESP}*(.*)$`
  ),
  // "NOME.ext (arquivo anexado)" / "(file attached)" — formato Android
  anexoSufixo: new RegExp(`\\u200e?${ESP}*(.+\\.(?:${EXT_ALT}))${ESP}*\\((?:arquivo anexado|file attached)\\)`, 'i'),
  // "<anexado: NOME.ext>" / "<attached: NOME.ext>" — formato iOS
  anexoPrefixo: new RegExp(`\\u200e?${ESP}*<(?:anexado|attached):${ESP}*(.+\\.(?:${EXT_ALT}))>`, 'i'),
  numeroLegenda: /^(\d+)/,
  // Formato do protocolo: 10 dígitos começando com 20XX. O ano mínimo é validado em isProtocoloValido().
  protocoloFormato: /^20\d{8}$/,
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

// Valida se o número é um protocolo válido: 10 dígitos começando com um ano >= anoMinimoProtocolo.
function isProtocoloValido(numero) {
  if (!numero) return false;
  if (!REGEX.protocoloFormato.test(numero)) return false;
  const ano = parseInt(numero.slice(0, 4), 10);
  return ano >= CONFIG.anoMinimoProtocolo;
}

// Procura protocolos válidos em QUALQUER posição do texto, tolerando separadores
// (espaço, ponto, traço) entre os dígitos. Ex.: "OS 2026-010728 concluída" -> ["2026010728"].
// Esta é a principal melhoria anti-órfã: antes o protocolo só era lido no INÍCIO da legenda.
function extrairProtocolos(texto) {
  if (!texto) return [];
  // Reconstrói números quebrados por separador: "2026 010728" / "2026-010728" -> "2026010728"
  const normalizado = texto.replace(/(\d)[\s.\-]+(?=\d)/g, '$1');
  const sequencias = normalizado.match(/\d{10,}/g) || [];
  const protocolos = [];
  for (const seq of sequencias) {
    // Sequência com mais de 10 dígitos: tenta o prefixo de 10 (protocolo + lixo grudado)
    const candidato = seq.length === 10 ? seq : seq.slice(0, 10);
    if (isProtocoloValido(candidato)) protocolos.push(candidato);
  }
  return protocolos;
}

// Coleta protocolos de um texto para dentro do bloco. Se achar protocolo(s) válido(s) em
// qualquer posição, guarda em legendas; senão guarda o número "cru" do início (p/ nomear sem_legenda)
// e o restante como texto.
function coletarProtocolos(bloco, texto) {
  if (!texto) return;
  if (texto.trim()) bloco.textosBrutos.push(texto.trim());
  const validos = extrairProtocolos(texto);
  if (validos.length > 0) {
    bloco.legendas.push(...validos);
    return;
  }
  const numMatch = texto.trim().match(REGEX.numeroLegenda);
  if (numMatch) {
    bloco.legendasInvalidas.push(numMatch[1]);
    const textoApos = texto.replace(/^\d+\s*/, '').trim();
    if (textoApos && !textoApos.includes('Mensagem apagada')) {
      bloco.textos.push(textoApos);
    }
  } else if (!texto.includes('Mensagem apagada')) {
    bloco.textos.push(texto);
  }
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

// Constrói um Date a partir das partes capturadas. Retorna null se a data for inválida.
// Trata ano de 2 dígitos (20XX) e horário 12h com AM/PM.
function montarData(dia, mes, ano, hora, min, seg, ampm) {
  let a = parseInt(ano, 10);
  if (a < 100) a += 2000;
  let h = parseInt(hora, 10);
  if (ampm) {
    const ehPM = /p/i.test(ampm);
    if (ehPM && h < 12) h += 12;
    if (!ehPM && h === 12) h = 0;
  }
  const d = new Date(a, parseInt(mes, 10) - 1, parseInt(dia, 10), h, parseInt(min, 10), seg ? parseInt(seg, 10) : 0);
  return isNaN(d.getTime()) ? null : d;
}

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

      const [_, dia, mes, ano, hora, minuto, seg, ampm, autor, conteudoMsg] = match;
      const data = montarData(dia, mes, ano, hora, minuto, seg, ampm);
      const dataStr = `${dia}/${mes}/${ano} ${hora}:${minuto}${ampm ? ' ' + ampm : ''}`;
      if (!data) {
        adicionarAlerta('info', `Data inválida no cabeçalho: "${linha.slice(0, 60)}"`);
      }

      mensagemAtual = {
        data,
        dataStr,
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
  const match = mensagem.conteudo.match(REGEX.anexoSufixo) || mensagem.conteudo.match(REGEX.anexoPrefixo);
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
      legendas: [],          // protocolos válidos (achados em qualquer posição)
      legendasInvalidas: [], // números crus que não são protocolo válido (p/ nomear sem_legenda)
      textos: [],
      textosBrutos: [],      // toda legenda/linha crua do bloco (usado pelo diagnóstico)
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

      // Processa linhas de continuação (legenda/protocolo após a mídia — qualquer posição)
      for (const linha of msg.linhasContinuacao) {
        coletarProtocolos(blocoAtual, linha);
      }
    }
    // Mensagem de texto (não mídia) do mesmo autor dentro da tolerância
    else if (blocoAtual && msg.autor === blocoAtual.autor) {
      const diffTempo = diferencaMinutos(blocoAtual.ultimaData, msg.data);

      if (diffTempo <= CONFIG.toleranciaMinutos) {
        coletarProtocolos(blocoAtual, msg.conteudo);
        for (const linha of msg.linhasContinuacao) {
          coletarProtocolos(blocoAtual, linha);
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

// Junta blocos que apontam para o MESMO protocolo único (fotos da mesma OS separadas no tempo).
// Recupera órfãs do caso "foto da mesma OS enviada depois da janela de tolerância".
function juntarBlocosPorProtocolo(blocos) {
  const resultado = [];
  const indicePorProto = new Map();

  for (const bloco of blocos) {
    const protos = [...new Set(bloco.legendas)];

    if (protos.length === 1 && indicePorProto.has(protos[0])) {
      const alvo = resultado[indicePorProto.get(protos[0])];
      alvo.midias.push(...bloco.midias);
      alvo.textos.push(...bloco.textos);
      alvo.textosBrutos.push(...(bloco.textosBrutos || []));
      alvo.legendasInvalidas.push(...(bloco.legendasInvalidas || []));
      if (bloco.ultimaData && (!alvo.ultimaData || bloco.ultimaData > alvo.ultimaData)) {
        alvo.ultimaData = bloco.ultimaData;
      }
      adicionarAlerta('pasta_unida', `Protocolo ${protos[0]}: blocos separados no tempo foram unidos (${bloco.autor})`);
      continue;
    }

    if (protos.length === 1) {
      indicePorProto.set(protos[0], resultado.length);
    }
    resultado.push(bloco);
  }

  return resultado;
}

// (Opcional, desligado por padrão) Faz fotos SEM legenda herdarem o último protocolo válido
// do mesmo autor, dentro de uma janela de tempo. Ligar via CONFIG.herdarProtocolo.
function herdarProtocoloVizinho(blocos) {
  let ultimo = null; // { protocolo, autor, data }
  for (const bloco of blocos) {
    const protos = [...new Set(bloco.legendas)];
    if (protos.length === 1) {
      ultimo = { protocolo: protos[0], autor: bloco.autor, data: bloco.ultimaData };
    } else if (protos.length === 0 && (bloco.legendasInvalidas || []).length === 0 && ultimo) {
      const mesmoAutor = ultimo.autor === bloco.autor;
      const dentroJanela = diferencaMinutos(ultimo.data, bloco.primeiraData) <= CONFIG.janelaHerancaMinutos;
      if (mesmoAutor && dentroJanela) {
        bloco.legendas.push(ultimo.protocolo);
        adicionarAlerta('info', `Foto(s) sem legenda herdaram o protocolo ${ultimo.protocolo} (${bloco.autor})`);
      }
    }
  }
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
    // bloco.legendas já contém apenas protocolos válidos (extraídos de qualquer posição).
    const protocolosValidos = [...new Set(bloco.legendas)];
    const protocolosInvalidos = [...new Set(bloco.legendasInvalidas || [])];

    // Alerta para números crus que não são protocolo válido
    for (const invalido of protocolosInvalidos) {
      adicionarAlerta('protocolo_invalido',
        `Protocolo "${invalido}" inválido (esperado 10 dígitos começando em ano >= ${CONFIG.anoMinimoProtocolo}) - ${bloco.autor} - enviado para sem_legenda`);
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
  let blocos = agruparBlocos(mensagens);
  // (opcional) fotos sem legenda herdam o protocolo do vizinho do mesmo autor
  if (CONFIG.herdarProtocolo) {
    blocos = herdarProtocoloVizinho(blocos);
  }
  // junta blocos da mesma OS separados no tempo (reduz órfãs)
  blocos = juntarBlocosPorProtocolo(blocos);
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

// Só executa o fluxo quando o arquivo é rodado diretamente (não quando importado por outro script,
// como o analisar-orfas.js, que reusa as funções de parsing/validação).
const ehExecucaoDireta = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (ehExecucaoDireta) {
  main().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
}

export { CONFIG, REGEX, parseChat, agruparBlocos, extrairMidia, extrairProtocolos, isProtocoloValido };