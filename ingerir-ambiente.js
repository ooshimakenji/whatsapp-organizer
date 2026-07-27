/**
 * Fallback de reprocessamento em massa: lê o MESMO export do WhatsApp usado
 * pelo whatsapp-organizer.js (input/*.txt + mídias) e ingere via
 * POST /fotos/ingest — o mesmo endpoint que o listener ao vivo do
 * ituran_avisos usa. Serve pra quando o ambiente ou a internet caírem
 * durante o envio ao vivo: exporta a conversa de novo cobrindo o período
 * afetado e roda este script pra preencher o que faltou.
 *
 * Dedup de graça: /fotos/ingest já deduplica por hash sha256 dentro da mesma
 * saída (idempotente) — rodar 2x sobre o mesmo export não duplica fotos.
 *
 * Blocos com legenda ambígua (0 ou >1 protocolo válido) NÃO são ingeridos
 * automaticamente — vão pro relatório como "revisão manual" (mesmo destino
 * que o whatsapp-organizer.js já dá pra esses casos na pasta sem_legenda/).
 *
 * Uso:
 *   node ingerir-ambiente.js --dry-run   # só relata o que faria
 *   node ingerir-ambiente.js             # ingere de verdade
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, parseChat, agruparBlocos } from './whatsapp-organizer.js';
import { ambienteHabilitado, ingestFoto } from './ambienteClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const RETRY_DELAYS_MS = [1000, 3000];

const MIME_POR_EXTENSAO = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeDoArquivo(nomeArquivo) {
  return MIME_POR_EXTENSAO[path.extname(nomeArquivo).toLowerCase()] || null;
}

async function ingerirComRetry(args) {
  let ultimoErro;
  for (let tentativa = 0; tentativa <= RETRY_DELAYS_MS.length; tentativa++) {
    try {
      return await ingestFoto(args);
    } catch (err) {
      ultimoErro = err;
      if (tentativa < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[tentativa]);
    }
  }
  throw ultimoErro;
}

async function main() {
  if (!ambienteHabilitado() && !DRY_RUN) {
    console.error('❌ AMBIENTE_API_URL/AMBIENTE_BOT_LOGIN/AMBIENTE_BOT_SENHA não configurados (.env). Use --dry-run pra só simular.');
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG.inputDir)) {
    console.error('❌ Pasta input/ não encontrada.');
    process.exit(1);
  }
  const arquivoTxt = fs.readdirSync(CONFIG.inputDir).find((f) => f.endsWith('.txt'));
  if (!arquivoTxt) {
    console.error('❌ Nenhum arquivo .txt encontrado em input/.');
    process.exit(1);
  }

  console.log(`📖 Lendo: ${arquivoTxt}${DRY_RUN ? ' (dry-run)' : ''}`);
  const conteudo = fs.readFileSync(path.join(CONFIG.inputDir, arquivoTxt), 'utf-8');
  const mensagens = parseChat(conteudo);
  const blocos = agruparBlocos(mensagens);
  console.log(`📦 ${blocos.length} blocos de mídia identificados`);

  const revisaoManual = [];
  let ingeridas = 0;
  let falhas = 0;

  for (const bloco of blocos) {
    const protocolos = [...new Set(bloco.legendas)];
    if (protocolos.length !== 1) {
      revisaoManual.push({
        autor: bloco.autor,
        motivo: protocolos.length === 0 ? 'sem protocolo válido na legenda' : `múltiplos protocolos (${protocolos.join(', ')})`,
        qtdFotos: bloco.midias.length,
      });
      continue;
    }

    const osSequencial = protocolos[0];
    const legenda = bloco.textos.join(' ').trim() || undefined;

    for (const midia of bloco.midias) {
      const mime = mimeDoArquivo(midia.arquivo);
      if (!mime) continue; // vídeos etc. — /fotos/ingest só aceita foto

      const caminho = path.join(CONFIG.inputDir, midia.arquivo);
      if (!fs.existsSync(caminho)) {
        falhas++;
        console.warn(`⚠️  Arquivo não encontrado: ${midia.arquivo} (OS ${osSequencial})`);
        continue;
      }

      if (DRY_RUN) {
        ingeridas++;
        continue;
      }

      try {
        const buffer = fs.readFileSync(caminho);
        const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        await ingerirComRetry({ osSequencial, dataUrl, legenda });
        ingeridas++;
      } catch (err) {
        falhas++;
        console.warn(`⚠️  Falha ao ingerir ${midia.arquivo} (OS ${osSequencial}): ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Concluído${DRY_RUN ? ' (dry-run — nada foi enviado)' : ''}!`);
  console.log(`   - ${ingeridas} fotos ${DRY_RUN ? 'seriam ingeridas' : 'ingeridas'}`);
  console.log(`   - ${falhas} falhas`);
  console.log(`   - ${revisaoManual.length} blocos p/ revisão manual (${revisaoManual.reduce((acc, r) => acc + r.qtdFotos, 0)} fotos)`);
  if (revisaoManual.length > 0) {
    const LIMITE_EXIBICAO = 30;
    console.log('\n📋 Revisão manual (mesmo destino do whatsapp-organizer.js — sem_legenda/):');
    for (const r of revisaoManual.slice(0, LIMITE_EXIBICAO)) {
      console.log(`   - ${r.autor}: ${r.motivo} (${r.qtdFotos} foto(s))`);
    }
    if (revisaoManual.length > LIMITE_EXIBICAO) {
      console.log(`   … e mais ${revisaoManual.length - LIMITE_EXIBICAO} bloco(s)`);
    }
  }
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
