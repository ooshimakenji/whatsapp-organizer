import fs from 'fs';
import path from 'path';

const EXTENSOES_FOTO = ['.jpg', '.jpeg', '.png', '.webp'];
const REGEX_PROTOCOLO = /^(202[56]\d{6})$/;

function getTimestamp() {
  const now = new Date();
  return now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
}

function verificarPasta(dirPath) {
  const resultado = [];

  const subpastas = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && REGEX_PROTOCOLO.test(d.name))
    .map(d => d.name)
    .sort();

  for (const pasta of subpastas) {
    const caminhoCompleto = path.join(dirPath, pasta);
    const fotos = fs.readdirSync(caminhoCompleto, { withFileTypes: true })
      .filter(f => f.isFile() && EXTENSOES_FOTO.includes(path.extname(f.name).toLowerCase()));

    resultado.push({
      protocolo: pasta,
      qtdFotos: fotos.length,
      alerta: fotos.length < 3,
    });
  }

  return resultado;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Uso: node verificar-fotos.js <caminho_pasta> [arquivo_saida.txt]');
    console.error('Exemplo: node verificar-fotos.js "C:\\output\\fotos-2026-01-22_18-53"');
    process.exit(1);
  }

  const dirPath = args[0];
  const arquivoSaida = args[1] || `verificacao-fotos_${getTimestamp()}.txt`;

  if (!fs.existsSync(dirPath)) {
    console.error(`Pasta nao encontrada: ${dirPath}`);
    process.exit(1);
  }

  console.log(`Verificando pastas de protocolo em: ${dirPath}\n`);

  const resultado = verificarPasta(dirPath);

  if (resultado.length === 0) {
    console.log('Nenhuma pasta de protocolo valido encontrada.');
    return;
  }

  const comAlerta = resultado.filter(r => r.alerta);
  const semAlerta = resultado.filter(r => !r.alerta);

  // Console
  console.log(`Total de pastas de protocolo: ${resultado.length}`);
  console.log(`Com menos de 3 fotos: ${comAlerta.length}`);
  console.log(`OK (3+ fotos): ${semAlerta.length}\n`);

  if (comAlerta.length > 0) {
    console.log('PASTAS COM MENOS DE 3 FOTOS:');
    console.log('-'.repeat(40));
    for (const r of comAlerta) {
      console.log(`  ${r.protocolo} -> ${r.qtdFotos} foto(s)`);
    }
  } else {
    console.log('Todas as pastas tem 3 ou mais fotos.');
  }

  // Relatorio em arquivo
  const linhas = [
    '==========================================',
    'VERIFICACAO DE FOTOS POR PROTOCOLO',
    '==========================================',
    `Data/Hora: ${new Date().toLocaleString('pt-BR')}`,
    `Pasta verificada: ${dirPath}`,
    `Extensoes consideradas: ${EXTENSOES_FOTO.join(', ')}`,
    '',
    `Total de pastas de protocolo: ${resultado.length}`,
    `Com menos de 3 fotos: ${comAlerta.length}`,
    `OK (3+ fotos): ${semAlerta.length}`,
    '',
    '==========================================',
    'DETALHES',
    '==========================================',
  ];

  if (comAlerta.length > 0) {
    linhas.push('');
    linhas.push('PASTAS COM MENOS DE 3 FOTOS:');
    for (const r of comAlerta) {
      linhas.push(`  ${r.protocolo} -> ${r.qtdFotos} foto(s)`);
    }
  }

  if (semAlerta.length > 0) {
    linhas.push('');
    linhas.push('PASTAS OK (3+ fotos):');
    for (const r of semAlerta) {
      linhas.push(`  ${r.protocolo} -> ${r.qtdFotos} foto(s)`);
    }
  }

  linhas.push('');

  fs.writeFileSync(arquivoSaida, linhas.join('\n'));
  console.log(`\nRelatorio salvo em: ${arquivoSaida}`);
}

main();
