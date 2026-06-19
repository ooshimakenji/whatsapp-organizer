// ============================================
// DIAGNÓSTICO DE ÓRFÃS
// ============================================
// Script READ-ONLY: não copia nem move nada. Lê o _chat.txt de input/, simula a
// classificação e mostra QUANTAS fotos ficam sem pasta de protocolo (órfãs) e POR QUÊ.
// Também estima quantas a melhoria de "protocolo em qualquer posição" recuperou
// em relação à lógica antiga (que só lia o número no início da legenda).
//
// Uso:  node analisar-orfas.js
// ============================================

import fs from 'fs';
import path from 'path';
import { CONFIG, parseChat, agruparBlocos, isProtocoloValido } from './whatsapp-organizer.js';

// Lógica ANTIGA: protocolo só conta se estiver no INÍCIO da legenda.
function protocoloPelaLogicaAntiga(textosBrutos) {
  for (const t of textosBrutos || []) {
    const m = t.trim().match(/^(\d+)/);
    if (m && isProtocoloValido(m[1])) return m[1];
  }
  return null;
}

function pct(parte, total) {
  if (!total) return '0%';
  return `${((parte / total) * 100).toFixed(1)}%`;
}

function main() {
  if (!fs.existsSync(CONFIG.inputDir)) {
    console.error('❌ Pasta input/ não encontrada. Coloque o _chat.txt em input/.');
    process.exit(1);
  }
  const arquivoTxt = fs.readdirSync(CONFIG.inputDir).find(f => f.endsWith('.txt'));
  if (!arquivoTxt) {
    console.error('❌ Nenhum arquivo .txt encontrado em input/');
    process.exit(1);
  }

  const conteudo = fs.readFileSync(path.join(CONFIG.inputDir, arquivoTxt), 'utf-8');
  const blocos = agruparBlocos(parseChat(conteudo));

  // Categorias (contadas em FOTOS, não em blocos)
  const cat = {
    ok: 0,             // protocolo único, achado tanto pela lógica antiga quanto pela nova
    recuperado: 0,     // protocolo achado SÓ pela nova lógica (estava no meio do texto / com separador)
    multiplas: 0,      // bloco com >1 protocolo válido -> vai p/ sem_legenda (precisa decidir manual)
    orfa_invalido: 0,  // tem número, mas não é protocolo válido (provável erro de digitação)
    orfa_com_texto: 0, // tem legenda de TEXTO (ex.: endereço), mas nenhum protocolo numérico
    orfa_vazio: 0,     // nenhuma legenda nenhuma -> foto enviada sem nada
  };
  const exemplosTexto = [];
  const exemplosInvalido = [];
  const exemplosSemLegenda = [];
  const exemplosRecuperado = [];
  let totalFotos = 0;

  for (const bloco of blocos) {
    const n = bloco.midias.length;
    totalFotos += n;
    const protocolosNovos = [...new Set(bloco.legendas)];

    if (protocolosNovos.length === 1) {
      const antigo = protocoloPelaLogicaAntiga(bloco.textosBrutos);
      if (antigo === protocolosNovos[0]) {
        cat.ok += n;
      } else {
        cat.recuperado += n;
        if (exemplosRecuperado.length < 8) {
          exemplosRecuperado.push(`${protocolosNovos[0]}  <-  "${(bloco.textosBrutos[0] || '').slice(0, 50)}"`);
        }
      }
    } else if (protocolosNovos.length > 1) {
      cat.multiplas += n;
    } else if ((bloco.legendasInvalidas || []).length > 0) {
      cat.orfa_invalido += n;
      if (exemplosInvalido.length < 8) {
        exemplosInvalido.push(`${bloco.autor}: "${[...new Set(bloco.legendasInvalidas)].join(', ')}"`);
      }
    } else if ((bloco.textos || []).length > 0) {
      cat.orfa_com_texto += n;
      if (exemplosTexto.length < 8) {
        exemplosTexto.push(`${bloco.autor}: "${bloco.textos[0].slice(0, 50)}"`);
      }
    } else {
      cat.orfa_vazio += n;
      if (exemplosSemLegenda.length < 8) {
        exemplosSemLegenda.push(`${bloco.autor} - ${bloco.primeiraData ? bloco.primeiraData.toLocaleString('pt-BR') : 's/data'} (${n} foto[s])`);
      }
    }
  }

  const orfas = cat.multiplas + cat.orfa_invalido + cat.orfa_com_texto + cat.orfa_vazio;

  const linhas = [];
  const print = (s = '') => { linhas.push(s); console.log(s); };

  print('==========================================');
  print('DIAGNÓSTICO DE ÓRFÃS - WhatsApp Organizer');
  print('==========================================');
  print(`Arquivo analisado: ${arquivoTxt}`);
  print(`Total de fotos/mídias: ${totalFotos}`);
  print('');
  print(`✅ Com protocolo (pasta real): ${cat.ok + cat.recuperado}  (${pct(cat.ok + cat.recuperado, totalFotos)})`);
  print(`   - já funcionavam antes:      ${cat.ok}`);
  print(`   - RECUPERADAS pela melhoria: ${cat.recuperado}  (protocolo no meio do texto / com separador)`);
  print('');
  print(`⚠️  Órfãs (sem pasta de protocolo): ${orfas}  (${pct(orfas, totalFotos)})`);
  print(`   - COM legenda de texto (ex.: endereço): ${cat.orfa_com_texto}  (${pct(cat.orfa_com_texto, totalFotos)})  -> daria p/ organizar por esse texto`);
  print(`   - sem legenda nenhuma:       ${cat.orfa_vazio}  (${pct(cat.orfa_vazio, totalFotos)})  -> erro de quem envia / herança ou OCR`);
  print(`   - protocolo inválido (typo): ${cat.orfa_invalido}  (${pct(cat.orfa_invalido, totalFotos)})  -> número digitado errado`);
  print(`   - múltiplos protocolos:      ${cat.multiplas}  (${pct(cat.multiplas, totalFotos)})  -> decidir manual`);

  if (exemplosRecuperado.length) {
    print('');
    print('Exemplos recuperados pela nova lógica:');
    exemplosRecuperado.forEach(e => print(`   ${e}`));
  }
  if (exemplosTexto.length) {
    print('');
    print('Exemplos com legenda de texto (ex.: endereço):');
    exemplosTexto.forEach(e => print(`   ${e}`));
  }
  if (exemplosInvalido.length) {
    print('');
    print('Exemplos de protocolo inválido (typo):');
    exemplosInvalido.forEach(e => print(`   ${e}`));
  }
  if (exemplosSemLegenda.length) {
    print('');
    print('Exemplos de foto sem legenda:');
    exemplosSemLegenda.forEach(e => print(`   ${e}`));
  }
  print('==========================================');

  if (!fs.existsSync(CONFIG.logsDir)) fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  const saida = path.join(CONFIG.logsDir, 'diagnostico-orfas.txt');
  fs.writeFileSync(saida, linhas.join('\n'));
  console.log(`\n📄 Relatório salvo em: ${saida}`);
}

main();
