import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import ffmpeg from 'fluent-ffmpeg';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Configurações
const CONFIG = {
  RESOLUTION: '1280x720',
  SECOND: 1,  // Mudado de 2 para 1 (mais seguro para vídeos curtos)
  MIN_JPG_COUNT: 3,
  VIDEO_FORMAT: '.mp4',
  THUMBNAIL_PREFIX: 'thumbnail_',
  THUMBNAIL_EXT: '.jpg',
  
  // Estratégias de paralelização
  THRESHOLDS: {
    SEQUENTIAL: 5,
    PARALLEL_2: 15,
    PARALLEL_3: 40,
    PARALLEL_4: Infinity
  }
};

// Cores para logs
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  cyan: '\x1b[96m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Verificar se FFmpeg está instalado
async function checkFFmpeg() {
  try {
    await execAsync('ffmpeg -version');
    log('✓ FFmpeg encontrado!', 'green');
    return true;
  } catch (error) {
    log('✗ FFmpeg não encontrado! Instale o FFmpeg primeiro.', 'red');
    return false;
  }
}

// Perguntar caminho da pasta
function askForPath() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\nDigite o caminho da pasta raiz: ', (answer) => {
      rl.close();
      resolve(answer.trim().replace(/"/g, ''));
    });
  });
}

// Perguntar confirmação
function askConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (S/n): `, (answer) => {
      rl.close();
      const response = answer.trim().toLowerCase();
      resolve(response === '' || response === 's' || response === 'sim');
    });
  });
}

// Contar arquivos JPG em uma pasta
async function countJPGs(folderPath) {
  try {
    const files = await fs.readdir(folderPath);
    const jpgFiles = files.filter(file => 
      file.toLowerCase().endsWith('.jpg')
    );
    return jpgFiles.length;
  } catch (error) {
    return 0;
  }
}

// Encontrar arquivos MP4 em uma pasta
async function findMP4s(folderPath) {
  try {
    const files = await fs.readdir(folderPath);
    const mp4Files = files.filter(file => 
      file.toLowerCase().endsWith(CONFIG.VIDEO_FORMAT)
    );
    return mp4Files;
  } catch (error) {
    return [];
  }
}

// Gerar próximo nome de thumbnail disponível
async function getNextThumbnailName(folderPath) {
  const files = await fs.readdir(folderPath);
  const thumbnails = files.filter(file => 
    file.startsWith(CONFIG.THUMBNAIL_PREFIX) && file.endsWith(CONFIG.THUMBNAIL_EXT)
  );
  
  let nextNumber = 1;
  while (thumbnails.includes(`${CONFIG.THUMBNAIL_PREFIX}${String(nextNumber).padStart(3, '0')}${CONFIG.THUMBNAIL_EXT}`)) {
    nextNumber++;
  }
  
  return `${CONFIG.THUMBNAIL_PREFIX}${String(nextNumber).padStart(3, '0')}${CONFIG.THUMBNAIL_EXT}`;
}

// Extrair thumbnail de um vídeo (MÉTODO MAIS ROBUSTO)
function extractThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`\n  🎬 Tentando extrair:`);
    console.log(`     Vídeo: ${videoPath}`);
    console.log(`     Saída: ${outputPath}`);
    
    ffmpeg(videoPath)
      .seekInput(CONFIG.SECOND)   // Pula para o segundo configurado
      .frames(1)                   // Extrai apenas 1 frame
      .size(CONFIG.RESOLUTION)     // Define resolução
      .output(outputPath)          // Arquivo de saída
      .outputOptions([
        '-q:v 2'                   // Qualidade JPEG (2 = alta, 1-31, menor = melhor)
      ])
      .on('start', (commandLine) => {
        console.log(`  ⚙️  Comando: ${commandLine.substring(0, 150)}...`);
      })
      .on('end', () => {
        console.log(`  ✓ Thumbnail criado: ${path.basename(outputPath)}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.log(`  ✗ ERRO FFmpeg:`);
        console.log(`     Mensagem: ${err.message}`);
        if (stderr) {
          const stderrShort = stderr.substring(0, 300);
          console.log(`     Stderr: ${stderrShort}...`);
        }
        reject(err);
      })
      .run();  // IMPORTANTE: força execução imediata
  });
}

// FASE 1: Análise rápida das pastas
async function analyzeFolders(rootPath) {
  log('\n📊 Analisando estrutura de pastas...', 'blue');
  
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const subfolders = entries.filter(entry => entry.isDirectory());
    
    if (subfolders.length === 0) {
      return { total: 0, needProcessing: [], alreadyOk: 0, noVideos: 0 };
    }
    
    const analysis = {
      total: subfolders.length,
      needProcessing: [],
      alreadyOk: 0,
      noVideos: 0
    };
    
    for (const subfolder of subfolders) {
      const subfolderPath = path.join(rootPath, subfolder.name);
      const jpgCount = await countJPGs(subfolderPath);
      
      if (jpgCount >= CONFIG.MIN_JPG_COUNT) {
        analysis.alreadyOk++;
      } else {
        const mp4Files = await findMP4s(subfolderPath);
        if (mp4Files.length > 0) {
          analysis.needProcessing.push({
            path: subfolderPath,
            name: subfolder.name,
            currentJPGs: jpgCount,
            videos: mp4Files.length,
            needed: CONFIG.MIN_JPG_COUNT - jpgCount
          });
        } else {
          analysis.noVideos++;
        }
      }
    }
    
    return analysis;
  } catch (error) {
    log(`✗ Erro ao analisar pastas: ${error.message}`, 'red');
    return null;
  }
}

// Decidir estratégia baseada na análise
function decideStrategy(foldersToProcess) {
  const count = foldersToProcess;
  
  if (count <= CONFIG.THRESHOLDS.SEQUENTIAL) {
    return { mode: 'sequencial', concurrent: 1, reason: 'Poucas pastas, overhead não compensa' };
  } else if (count <= CONFIG.THRESHOLDS.PARALLEL_2) {
    return { mode: 'paralelo×2', concurrent: 2, reason: 'Ganho moderado com baixo uso de recursos' };
  } else if (count <= CONFIG.THRESHOLDS.PARALLEL_3) {
    return { mode: 'paralelo×3', concurrent: 3, reason: 'Ganho significativo otimizado' };
  } else {
    return { mode: 'paralelo×4', concurrent: 4, reason: 'Máximo desempenho para grande volume' };
  }
}

// Estimar tempo
function estimateTime(foldersToProcess, concurrent) {
  const avgTimePerFolder = 3;
  const sequentialTime = foldersToProcess * avgTimePerFolder;
  const parallelTime = Math.ceil(foldersToProcess / concurrent) * avgTimePerFolder;
  
  return {
    sequential: sequentialTime,
    parallel: parallelTime,
    saved: sequentialTime - parallelTime
  };
}

// Formatar segundos para legível
function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// Processar uma subpasta
async function processSubfolder(folderInfo, progressCallback) {
  const { path: subfolderPath, name, currentJPGs, videos, needed } = folderInfo;
  
  try {
    const mp4Files = await findMP4s(subfolderPath);
    if (mp4Files.length === 0) {
      return { success: false, generated: 0, error: 'Sem vídeos' };
    }
    
    const videoPath = path.join(subfolderPath, mp4Files[0]);
    let generated = 0;
    
    for (let i = 0; i < needed; i++) {
      try {
        const thumbnailName = await getNextThumbnailName(subfolderPath);
        const outputPath = path.join(subfolderPath, thumbnailName);
        
        await extractThumbnail(videoPath, outputPath);
        generated++;
      } catch (error) {
        console.log(`  ⚠️  Falhou thumbnail ${i + 1}: ${error.message}`);
      }
    }
    
    if (progressCallback) progressCallback(name, generated);
    return { success: true, generated };
    
  } catch (error) {
    if (progressCallback) progressCallback(name, 0, error.message);
    return { success: false, generated: 0, error: error.message };
  }
}

// Processador paralelo controlado
async function processInParallel(folders, concurrent, onProgress) {
  const results = [];
  const queue = [...folders];
  const inProgress = new Set();
  
  let completed = 0;
  const total = folders.length;
  
  const processNext = async () => {
    if (queue.length === 0) return;
    
    const folder = queue.shift();
    inProgress.add(folder.name);
    
    const result = await processSubfolder(folder, (name, generated, error) => {
      completed++;
      inProgress.delete(name);
      if (onProgress) onProgress(completed, total, name, generated, error);
    });
    
    results.push({ folder: folder.name, ...result });
    
    if (queue.length > 0) {
      await processNext();
    }
  };
  
  // Iniciar processamento paralelo
  const workers = Array(Math.min(concurrent, folders.length))
    .fill(null)
    .map(() => processNext());
  
  await Promise.all(workers);
  return results;
}

// Barra de progresso
function showProgress(current, total, folderName, generated, error) {
  const percentage = Math.round((current / total) * 100);
  const barLength = 30;
  const filledLength = Math.round((barLength * current) / total);
  const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
  
  const status = error 
    ? `${colors.red}✗ Erro: ${folderName}${colors.reset}`
    : `${colors.green}✓ ${folderName} (+${generated} img)${colors.reset}`;
  
  process.stdout.write(`\r[${bar}] ${percentage}% (${current}/${total}) ${status}` + ' '.repeat(20));
  
  if (current === total) {
    console.log('');
  }
}

// Função principal
async function main() {
  const startTime = Date.now();
  
  log('🎬 EXTRATOR INTELIGENTE DE THUMBNAILS', 'cyan');
  log('='.repeat(60), 'cyan');
  
  // Verificar FFmpeg
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) return;
  
  // Perguntar caminho
  const rootPath = await askForPath();
  
  // Verificar se o caminho existe
  try {
    await fs.access(rootPath);
    log(`✓ Caminho válido: ${rootPath}`, 'green');
  } catch (error) {
    log(`✗ Caminho inválido ou não encontrado!`, 'red');
    return;
  }
  
  // FASE 1: Análise
  const analysis = await analyzeFolders(rootPath);
  
  if (!analysis) return;
  
  if (analysis.total === 0) {
    log('\n⚠ Nenhuma subpasta encontrada!', 'yellow');
    return;
  }
  
  // Mostrar resultado da análise
  log(`   ${colors.blue}→${colors.reset} ${analysis.total} subpasta(s) encontrada(s)`, 'reset');
  log(`   ${colors.green}→${colors.reset} ${analysis.alreadyOk} já têm ${CONFIG.MIN_JPG_COUNT}+ JPGs (ok)`, 'reset');
  
  if (analysis.noVideos > 0) {
    log(`   ${colors.yellow}→${colors.reset} ${analysis.noVideos} sem vídeos MP4`, 'reset');
  }
  
  log(`   ${colors.magenta}→${colors.reset} ${analysis.needProcessing.length} precisam de processamento`, 'reset');
  
  if (analysis.needProcessing.length === 0) {
    log('\n✓ Todas as pastas já estão ok! Nada a fazer.', 'green');
    return;
  }
  
  // FASE 2: Decisão de estratégia
  const strategy = decideStrategy(analysis.needProcessing.length);
  const timeEstimate = estimateTime(analysis.needProcessing.length, strategy.concurrent);
  
  log('\n🤖 ESTRATÉGIA AUTOMÁTICA:', 'cyan');
  log(`   ✓ Modo: ${colors.magenta}${strategy.mode.toUpperCase()}${colors.reset}`, 'reset');
  log(`   ✓ Motivo: ${strategy.reason}`, 'reset');
  log(`   ✓ Tempo estimado: ${colors.green}~${formatTime(timeEstimate.parallel)}${colors.reset}`, 'reset');
  
  if (strategy.concurrent > 1) {
    log(`   ✓ (vs ${formatTime(timeEstimate.sequential)} no modo sequencial)`, 'reset');
    log(`   ✓ Economia: ${colors.green}~${formatTime(timeEstimate.saved)}${colors.reset}`, 'reset');
  }
  
  // FASE 3: Confirmação
  log('\n' + '='.repeat(60), 'cyan');
  const confirmed = await askConfirmation('\nDeseja continuar?');
  
  if (!confirmed) {
    log('\n✗ Operação cancelada pelo usuário.', 'yellow');
    return;
  }
  
  // FASE 4: Processamento
  log('\n🚀 Processando...', 'blue');
  log('');
  
  const results = await processInParallel(
    analysis.needProcessing,
    strategy.concurrent,
    showProgress
  );
  
  // FASE 5: Estatísticas finais
  const endTime = Date.now();
  const totalTime = Math.round((endTime - startTime) / 1000);
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalGenerated = results.reduce((sum, r) => sum + r.generated, 0);
  
  log('\n' + '='.repeat(60), 'cyan');
  log('\n📈 RESUMO FINAL:', 'green');
  log(`   Total de pastas analisadas: ${analysis.total}`, 'reset');
  log(`   Já estavam ok: ${analysis.alreadyOk}`, 'reset');
  log(`   Processadas com sucesso: ${colors.green}${successful}${colors.reset}`, 'reset');
  
  if (failed > 0) {
    log(`   Falharam: ${colors.red}${failed}${colors.reset}`, 'reset');
  }
  
  log(`   Total de thumbnails gerados: ${colors.green}${totalGenerated}${colors.reset}`, 'reset');
  log(`   Tempo total: ${colors.cyan}${formatTime(totalTime)}${colors.reset}`, 'reset');
  log(`   Estratégia usada: ${colors.magenta}${strategy.mode}${colors.reset}`, 'reset');
  
  log('\n✓ Processo concluído!', 'green');
}

// Executar
main().catch(error => {
  log(`\n✗ Erro fatal: ${error.message}`, 'red');
  process.exit(1);
});