// ============================================
// WhatsApp Organizer — MODO ENDEREÇO
// ============================================
// Para grupos que organizam por ENDEREÇO (rua + número) em vez de protocolo numérico.
// Cria uma pasta por endereço e junta as fotos do mesmo endereço.
//
// Recuperação das fotos SEM legenda (herança por sessão):
//   - Agrupa fotos do mesmo autor próximas no tempo numa "sessão" (janela configurável).
//   - Se a sessão tem UM único endereço, todas as fotos da sessão (inclusive as sem
//     legenda) vão para esse endereço. Isso resolve o caso "o time legenda só uma foto
//     do local e manda as outras sem legenda".
//
// Uso:
//   node whatsapp-organizer-endereco.js              # executa
//   node whatsapp-organizer-endereco.js --dry-run    # simula sem copiar
//   node whatsapp-organizer-endereco.js --sem-heranca# não herda; foto sem legenda -> sem_legenda
//   node whatsapp-organizer-endereco.js --janela=15  # muda a janela da sessão (min, padrão 10)
// ============================================

import fs from 'fs';
import { copyFile } from 'fs/promises';
import path from 'path';
import { CONFIG, parseChat, extrairMidia } from './whatsapp-organizer.js';

const dryRun = process.argv.includes('--dry-run');
const semHeranca = process.argv.includes('--sem-heranca');

// Janela (min) para a herança por vizinho captionado mais próximo (foto sem endereço próprio).
const janelaHerArg = process.argv.find(a => a.startsWith('--janela-heranca='));
const JANELA_HERANCA = janelaHerArg ? parseInt(janelaHerArg.split('=')[1], 10) : 25;

// --lista: saída "pastão" — uma pasta só, com as fotos renomeadas por endereço, na ordem de envio.
const lista = process.argv.includes('--lista');

const alertas = [];

function getTimestamp() {
  const now = new Date();
  return now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
}

function diffMin(d1, d2) {
  if (!d1 || !d2) return Infinity;
  return Math.abs(new Date(d1) - new Date(d2)) / 60000;
}

function tsArquivo(data) {
  if (!data) return 'sem-data';
  const d = new Date(data);
  if (isNaN(d.getTime())) return 'sem-data';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function sanitizarAutor(a) {
  if (!a) return 'desconhecido';
  return a.replace(/[<>:"/\\|?*]/g, '').trim();
}

// Endereço pronto para virar nome de pasta (legível, sem caracteres inválidos).
function enderecoDisplay(t) {
  return t.replace(/\s+/g, ' ').trim().replace(/[<>:"/\\|?*]/g, '').slice(0, 80).trim();
}

// Chave normalizada p/ agrupar variações do mesmo endereço:
// minúsculas, sem acentos, SEM prefixo de tipo de via, espaços colapsados.
// Ex.: "Rua das camélias 143" / "Das camélias 143" / "Rua dás camélias 143" -> "das camelias 143".
function enderecoKey(t) {
  let s = enderecoDisplay(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/^(rua|r|av|avenida|travessa|trav|rod|rodovia|estrada|alameda|al|beco|servidao)\.?\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function normaliza(t) {
  return enderecoDisplay(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Frases comuns que NÃO são endereço (chatter). A foto com nota procura um endereço vizinho ("mãe/pai").
const NOTAS = ['material pra recolher', 'tem material pra recolher', 'feito', 'feito pela prefeitura', 'ok', 'bom dia', 'boa tarde'];
function ehNota(t) {
  const s = normaliza(t);
  if (!s) return true;
  if (NOTAS.includes(s)) return true;
  if (/^esta feito/.test(s)) return true;      // "está feito", "está feito ja", ...
  if (!/[a-z]/.test(s)) return true;           // sem nenhuma letra -> não é endereço
  return false;
}

const PREFIXO_VIA = /^(rua|r|av|avenida|travessa|trav|rod|rodovia|estrada|alameda|al|beco|servidao)\b/;
// Texto AVULSO (mensagem solta) só vira endereço/âncora se parecer endereço:
// tem dígito (nº da casa) OU começa com tipo de via. Evita que "Está feito" vire endereço.
function pareceEndereco(t) {
  if (!t || ehNota(t)) return false;
  const s = normaliza(t);
  return /\d/.test(s) || PREFIXO_VIA.test(s);
}

// Endereço próprio de uma foto: primeira linha de continuação que NÃO seja nota.
function enderecoDeLinhas(linhas) {
  const t = (linhas || []).find(x => x && x.trim() && !ehNota(x));
  return t ? enderecoDisplay(t) : null;
}

async function copiarParalelo(tarefas) {
  const res = { copiados: 0, erros: 0 };
  for (let i = 0; i < tarefas.length; i += CONFIG.concorrencia) {
    const lote = tarefas.slice(i, i + CONFIG.concorrencia);
    await Promise.all(lote.map(async (t) => {
      if (dryRun) { res.copiados++; return; }
      try {
        await copyFile(t.origem, t.destino);
        res.copiados++;
      } catch (err) {
        alertas.push(`❌ Erro ao copiar ${t.nomeOriginal}: ${err.code || err.message}`);
        res.erros++;
      }
    }));
  }
  return res;
}

function gerarLog(stats, outputPath) {
  if (!fs.existsSync(CONFIG.logsDir)) fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  const logPath = path.join(CONFIG.logsDir, `${getTimestamp()}_endereco_relatorio.txt`);
  const conteudo = [
    '==========================================',
    'RELATÓRIO DE ORGANIZAÇÃO - WhatsApp ENDEREÇO',
    '==========================================',
    `Data/Hora: ${new Date().toLocaleString('pt-BR')}`,
    `Output: ${outputPath}`,
    `Modo: ${dryRun ? 'DRY-RUN (simulação)' : 'EXECUÇÃO REAL'}`,
    `Janela de herança: ${JANELA_HERANCA} min | Herança: ${semHeranca ? 'DESLIGADA' : 'LIGADA'}`,
    '',
    `Fotos com endereço direto: ${stats.comEndereco}`,
    `Fotos recuperadas por herança: ${stats.herdadas}`,
    `Fotos sem endereço (sem_legenda): ${stats.semEndereco}`,
    `Pastas de endereço criadas: ${stats.pastas}`,
    `Arquivos copiados: ${stats.copiados} | Erros: ${stats.erros}`,
    '',
    `ALERTAS (${alertas.length})`,
    alertas.length ? alertas.join('\n') : 'Nenhum.',
    '==========================================',
  ].join('\n');
  if (!dryRun) {
    fs.writeFileSync(logPath, conteudo);
    console.log(`\n📄 Log salvo em: ${logPath}`);
  } else {
    console.log(`\n📄 [DRY-RUN] Log seria salvo em: ${logPath}`);
  }
}

async function main() {
  console.log(`🏠 WhatsApp Organizer — MODO ENDEREÇO ${lista ? '(saída: PASTÃO/lista)' : '(saída: pastas)'}`);
  console.log(`   Janela de herança: ${JANELA_HERANCA} min | Herança: ${semHeranca ? 'desligada' : 'ligada'}${dryRun ? ' | DRY-RUN' : ''}\n`);

  if (!fs.existsSync(CONFIG.inputDir)) {
    console.error('❌ Pasta input/ não encontrada. Coloque o _chat.txt e as mídias em input/.');
    process.exit(1);
  }
  const arquivoTxt = fs.readdirSync(CONFIG.inputDir).find(f => f.endsWith('.txt'));
  if (!arquivoTxt) {
    console.error('❌ Nenhum arquivo .txt encontrado em input/');
    process.exit(1);
  }

  console.log(`📖 Lendo: ${arquivoTxt}`);
  const conteudo = fs.readFileSync(path.join(CONFIG.inputDir, arquivoTxt), 'utf-8');
  const mensagens = parseChat(conteudo);
  console.log(`📝 ${mensagens.length} mensagens`);

  const timestampChat = tsArquivo(mensagens[mensagens.length - 1]?.data);
  const outputPath = path.join(CONFIG.outputDir, `${lista ? 'lista' : 'enderecos'}-${timestampChat}`);
  if (!dryRun) fs.mkdirSync(outputPath, { recursive: true });

  // Passada por MENSAGEM (ordem do chat): cada foto guarda o SEU próprio endereço (legenda da própria
  // foto). Mensagens de texto que parecem endereço viram âncoras para a herança.
  const fotos = [];    // { arquivo, data, autor, enderecoProprio }
  const anchors = [];  // { autor, t, endereco } -> fotos captionadas + endereços avulsos
  for (const msg of mensagens) {
    if (!msg.autor) continue;
    const midia = extrairMidia(msg);
    if (midia && midia.tipo === 'anexo') {
      const proprio = enderecoDeLinhas(msg.linhasContinuacao);
      fotos.push({ arquivo: midia.arquivo, data: msg.data, autor: msg.autor, enderecoProprio: proprio });
      if (proprio) anchors.push({ autor: msg.autor, t: msg.data, endereco: proprio });
    } else if (!midia) {
      // Mensagem de texto: endereço avulso? (checa o conteúdo e as continuações)
      const cand = [msg.conteudo, ...(msg.linhasContinuacao || [])].find(x => pareceEndereco(x));
      if (cand) anchors.push({ autor: msg.autor, t: msg.data, endereco: enderecoDisplay(cand) });
    }
  }

  // Mapa canônico p/ juntar variações de escrita do mesmo endereço.
  const canon = new Map();
  for (const a of anchors) {
    const k = enderecoKey(a.endereco);
    if (!canon.has(k)) canon.set(k, a.endereco);
  }

  // Foto sem endereço próprio herda a âncora MAIS PRÓXIMA no tempo, do mesmo autor, dentro da janela.
  function vizinhoMaisProximo(foto) {
    let bestKey = null, bestDiff = Infinity, bestT = null;
    for (const a of anchors) {
      if (a.autor !== foto.autor) continue;
      const d = diffMin(a.t, foto.data);
      if (d < bestDiff || (d === bestDiff && a.t && bestT && a.t < bestT)) {
        bestDiff = d; bestKey = enderecoKey(a.endereco); bestT = a.t;
      }
    }
    return (bestKey !== null && bestDiff <= JANELA_HERANCA) ? canon.get(bestKey) : null;
  }

  const tarefas = [];
  const pastasUsadas = new Set();
  let comEndereco = 0, herdadas = 0, semEndereco = 0;
  let seq = 0; // contador global na ordem de envio (modo --lista)

  for (const foto of fotos) {
    // Prioridade: endereço da PRÓPRIA foto (nome canônico). Senão, herda do vizinho mais próximo.
    let endereco = foto.enderecoProprio ? canon.get(enderecoKey(foto.enderecoProprio)) : null;
    let origem = endereco ? 'direto' : null;
    if (!endereco && !semHeranca) {
      const herd = vizinhoMaisProximo(foto);
      if (herd) { endereco = herd; origem = 'herdado'; }
    }

    if (origem === 'direto') comEndereco++;
    else if (origem === 'herdado') herdadas++;
    else semEndereco++;

    // Modo PASTAS: subpasta por endereço (ou sem_legenda/{time}). Modo PASTÃO: tudo em outputPath.
    let pastaDestino = outputPath;
    if (!lista) {
      pastaDestino = endereco
        ? path.join(outputPath, endereco)
        : path.join(outputPath, 'sem_legenda', sanitizarAutor(foto.autor));
      if (!dryRun && !fs.existsSync(pastaDestino)) fs.mkdirSync(pastaDestino, { recursive: true });
    }
    if (endereco) pastasUsadas.add(enderecoKey(endereco));

    seq++;
    const ext = path.extname(foto.arquivo);
    let nome;
    if (lista) {
      const dataNome = tsArquivo(foto.data).replace('_', ' '); // AAAA-MM-DD HH-MM
      const rotulo = endereco || 'SEM ENDERECO';
      nome = `${String(seq).padStart(4, '0')} - ${rotulo} - ${dataNome}${ext}`;
    } else {
      nome = `${tsArquivo(foto.data)}_${sanitizarAutor(foto.autor)}_${foto.arquivo}`;
    }

    tarefas.push({
      origem: path.join(CONFIG.inputDir, foto.arquivo),
      destino: path.join(pastaDestino, nome),
      nomeOriginal: foto.arquivo,
    });
  }

  console.log(`\n📂 ${dryRun ? '[DRY-RUN] Processando para' : 'Copiando para'}: ${outputPath}`);
  console.log(`   ${tarefas.length} arquivos | ${comEndereco} com endereço, ${herdadas} herdadas, ${semEndereco} sem endereço`);
  const res = await copiarParalelo(tarefas);

  console.log(`\n✅ Concluído!`);
  console.log(`   - ${res.copiados} arquivos ${dryRun ? 'seriam copiados' : 'copiados'} em ${pastasUsadas.size} endereços`);
  console.log(`   - recuperadas por herança: ${herdadas}`);
  console.log(`   - sem endereço (sem_legenda): ${semEndereco}`);

  gerarLog({ comEndereco, herdadas, semEndereco, pastas: pastasUsadas.size, copiados: res.copiados, erros: res.erros }, outputPath);
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
