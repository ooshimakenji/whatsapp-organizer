import fs from 'fs';
import path from 'path';

// === CONFIGURAÇÃO ===
const DIRETORIO = process.argv[2] || '.';  // Passa o diretório como argumento ou usa o atual
const ARQUIVO_SAIDA = process.argv[3] || 'pastas.csv';

// Lê apenas as pastas do diretório
function listarPastas(diretorio) {
    const itens = fs.readdirSync(diretorio, { withFileTypes: true });
    
    return itens
        .filter(item => item.isDirectory())
        .map(item => item.name)
        .sort();
}

// Gera o CSV
function gerarCSV(pastas, arquivoSaida) {
    const linhas = ['Nome da Pasta'];  // Cabeçalho
    
    pastas.forEach(pasta => {
        // Escapa aspas duplas e envolve em aspas se tiver caracteres especiais
        const valorEscapado = pasta.includes(',') || pasta.includes('"') || pasta.includes('\n')
            ? `"${pasta.replace(/"/g, '""')}"`
            : pasta;
        linhas.push(valorEscapado);
    });
    
    fs.writeFileSync(arquivoSaida, linhas.join('\n'), 'utf8');
    console.log(`✓ Arquivo salvo: ${arquivoSaida}`);
    console.log(`✓ Total de pastas: ${pastas.length}`);
}

// Executa
try {
    const diretorioAbsoluto = path.resolve(DIRETORIO);
    console.log(`Lendo pastas de: ${diretorioAbsoluto}\n`);
    
    const pastas = listarPastas(diretorioAbsoluto);
    
    if (pastas.length === 0) {
        console.log('Nenhuma pasta encontrada no diretório.');
    } else {
        gerarCSV(pastas, ARQUIVO_SAIDA);
        console.log('\nPastas encontradas:');
        pastas.forEach(p => console.log(`  - ${p}`));
    }
} catch (erro) {
    console.error('Erro:', erro.message);
}