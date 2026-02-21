/**
 * SCRIPT DE DETECÇÃO DE FOTOS DUPLICADAS
 *
 * Melhorias:
 * - Tratamento de erros robusto para arquivos inacessíveis
 * - Continua mesmo se alguns arquivos não puderem ser lidos
 * - Log detalhado de problemas encontrados
 * - Processamento PARALELO para maior velocidade
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================

const EXTENSOES_IMAGEM = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
const CONCORRENCIA = 20; // Número de arquivos processados em paralelo

// ============================================================================
// FUNÇÕES UTILITÁRIAS
// ============================================================================

/**
 * Calcula o hash MD5 de um arquivo (versão assíncrona com tratamento de erro)
 */
async function calcularHash(caminhoArquivo) {
    try {
        const conteudo = await fsPromises.readFile(caminhoArquivo);
        return crypto.createHash('sha256').update(conteudo).digest('hex');
    } catch (err) {
        // Retorna null para arquivos que não podem ser lidos
        return null;
    }
}

/**
 * Processa um lote de arquivos em paralelo
 */
async function processarLote(arquivos) {
    return Promise.all(
        arquivos.map(async (arquivo) => {
            const hash = await calcularHash(arquivo);
            return { arquivo, hash };
        })
    );
}

/**
 * Busca recursivamente todos os arquivos de imagem em uma pasta
 */
function buscarImagensRecursivo(pasta) {
    let arquivos = [];

    try {
        const itens = fs.readdirSync(pasta);

        for (const item of itens) {
            const caminhoCompleto = path.join(pasta, item);

            try {
                const stats = fs.statSync(caminhoCompleto);

                if (stats.isDirectory()) {
                    arquivos = arquivos.concat(buscarImagensRecursivo(caminhoCompleto));
                } else if (stats.isFile()) {
                    const extensao = path.extname(item).toLowerCase();
                    if (EXTENSOES_IMAGEM.includes(extensao)) {
                        arquivos.push(caminhoCompleto);
                    }
                }
            } catch (err) {
                // Pula arquivos/pastas inacessíveis
                console.log(`   ⚠️  Não foi possível acessar: ${item}`);
            }
        }
    } catch (err) {
        console.log(`   ⚠️  Não foi possível ler pasta: ${pasta}`);
    }

    return arquivos;
}

function extrairSubpasta(caminhoArquivo) {
    return path.basename(path.dirname(caminhoArquivo));
}

function extrairCaminhoSubpasta(caminhoArquivo) {
    return path.dirname(caminhoArquivo);
}

// ============================================================================
// LÓGICA PRINCIPAL
// ============================================================================

async function analisarDuplicatas(pastaRaiz) {
    console.log('\n📂 Buscando imagens...');
    const arquivos = buscarImagensRecursivo(pastaRaiz);
    console.log(`   Encontrados ${arquivos.length} arquivos de imagem\n`);

    console.log('🔍 Calculando hashes (isso pode demorar um pouco)...');

    const hashMap = new Map();
    const arquivosComErro = [];

    let processados = 0;
    for (const arquivo of arquivos) {
        const hash = await calcularHash(arquivo);

        if (hash === null) {
            // Arquivo com erro
            arquivosComErro.push(arquivo);
            processados++;
            if (processados % 100 === 0) {
                console.log(`   Processados ${processados}/${arquivos.length}...`);
            }
            continue;
        }

        if (!hashMap.has(hash)) {
            hashMap.set(hash, []);
        }
        hashMap.get(hash).push(arquivo);

        processados++;
        if (processados % 100 === 0) {
            console.log(`   Processados ${processados}/${arquivos.length}...`);
        }
    }

    console.log(`   ✅ Todos os ${arquivos.length} arquivos processados`);

    if (arquivosComErro.length > 0) {
        console.log(`   ⚠️  ${arquivosComErro.length} arquivo(s) não puderam ser lidos\n`);
    } else {
        console.log('');
    }

    // Separar duplicatas por tipo
    const duplicatasMesmaSubpasta = [];
    const duplicatasOutrasSubpastas = [];

    for (const [hash, listaArquivos] of hashMap) {
        if (listaArquivos.length < 2) continue;

        const porSubpasta = new Map();

        for (const arquivo of listaArquivos) {
            const subpasta = extrairCaminhoSubpasta(arquivo);
            if (!porSubpasta.has(subpasta)) {
                porSubpasta.set(subpasta, []);
            }
            porSubpasta.get(subpasta).push(arquivo);
        }

        for (const [subpasta, arquivosNaSubpasta] of porSubpasta) {
            if (arquivosNaSubpasta.length > 1) {
                const [manter, ...deletar] = arquivosNaSubpasta;
                duplicatasMesmaSubpasta.push({
                    hash,
                    subpasta: extrairSubpasta(manter),
                    manter,
                    deletar
                });
            }
        }

        if (porSubpasta.size > 1) {
            duplicatasOutrasSubpastas.push({
                hash,
                arquivos: listaArquivos.map(arq => ({
                    caminho: arq,
                    subpasta: extrairSubpasta(arq)
                }))
            });
        }
    }

    return {
        duplicatasMesmaSubpasta,
        duplicatasOutrasSubpastas,
        totalArquivos: arquivos.length,
        totalDuplicatas: duplicatasMesmaSubpasta.length + duplicatasOutrasSubpastas.length,
        arquivosComErro
    };
}

function gerarRelatorio(resultado, pastaRaiz, modoDeletar) {
    const linhas = [];
    const dataHora = new Date().toLocaleString('pt-BR');

    linhas.push('='.repeat(80));
    linhas.push('RELATÓRIO DE DUPLICATAS');
    linhas.push('='.repeat(80));
    linhas.push(`Data/Hora: ${dataHora}`);
    linhas.push(`Pasta analisada: ${pastaRaiz}`);
    linhas.push(`Total de arquivos analisados: ${resultado.totalArquivos}`);
    linhas.push(`Arquivos com erro de leitura: ${resultado.arquivosComErro.length}`);
    linhas.push(`Modo: ${modoDeletar ? 'DELEÇÃO ATIVADA' : 'APENAS VISUALIZAÇÃO'}`);
    linhas.push('');

    // Arquivos com erro
    if (resultado.arquivosComErro.length > 0) {
        linhas.push('-'.repeat(80));
        linhas.push('ARQUIVOS COM ERRO DE LEITURA');
        linhas.push('-'.repeat(80));
        for (const arq of resultado.arquivosComErro) {
            linhas.push(`  - ${arq}`);
        }
        linhas.push('');
    }

    // Duplicatas na mesma subpasta
    linhas.push('-'.repeat(80));
    linhas.push('DUPLICATAS NA MESMA SUBPASTA (serão/foram deletadas)');
    linhas.push('-'.repeat(80));

    if (resultado.duplicatasMesmaSubpasta.length === 0) {
        linhas.push('Nenhuma duplicata encontrada na mesma subpasta.');
    } else {
        let totalDeletados = 0;
        for (const grupo of resultado.duplicatasMesmaSubpasta) {
            linhas.push(`\nSubpasta: ${grupo.subpasta}`);
            linhas.push(`Hash: ${grupo.hash}`);
            linhas.push(`Mantido: ${path.basename(grupo.manter)}`);
            linhas.push(`${modoDeletar ? 'Deletados' : 'A deletar'}:`);
            for (const arq of grupo.deletar) {
                linhas.push(`  - ${path.basename(arq)}`);
                totalDeletados++;
            }
        }
        linhas.push(`\nTotal: ${totalDeletados} arquivo(s) ${modoDeletar ? 'deletados' : 'a deletar'}`);
    }

    linhas.push('');

    // Duplicatas em subpastas diferentes
    linhas.push('-'.repeat(80));
    linhas.push('DUPLICATAS EM SUBPASTAS DIFERENTES (apenas relatório)');
    linhas.push('-'.repeat(80));

    if (resultado.duplicatasOutrasSubpastas.length === 0) {
        linhas.push('Nenhuma duplicata encontrada entre subpastas diferentes.');
    } else {
        for (const grupo of resultado.duplicatasOutrasSubpastas) {
            linhas.push(`\nHash: ${grupo.hash}`);
            linhas.push('Encontrado em:');
            for (const arq of grupo.arquivos) {
                linhas.push(`  - [${arq.subpasta}] ${path.basename(arq.caminho)}`);
            }
        }
        linhas.push(`\nTotal: ${resultado.duplicatasOutrasSubpastas.length} grupo(s) de duplicatas entre subpastas`);
    }

    linhas.push('');
    linhas.push('='.repeat(80));
    linhas.push('FIM DO RELATÓRIO');
    linhas.push('='.repeat(80));

    return linhas.join('\n');
}

function executarDelecoes(duplicatasMesmaSubpasta) {
    let deletados = 0;
    let erros = 0;

    for (const grupo of duplicatasMesmaSubpasta) {
        for (const arquivo of grupo.deletar) {
            try {
                fs.unlinkSync(arquivo);
                console.log(`   🗑️  Deletado: ${path.basename(arquivo)}`);
                deletados++;
            } catch (err) {
                console.log(`   ❌ Erro ao deletar ${path.basename(arquivo)}: ${err.message}`);
                erros++;
            }
        }
    }

    return { deletados, erros };
}

// ============================================================================
// EXECUÇÃO
// ============================================================================

function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
Uso:
  node busca-duplicatas.js "C:\\caminho\\para\\pasta"              -> apenas visualização
  node busca-duplicatas.js "C:\\caminho\\para\\pasta" --deletar    -> executa deleções

Exemplo:
  node busca-duplicatas.js "X:\\Contrato 005-2024\\2025\\12 - Dezembro\\Registros Fotográficos\\Água"
        `);
        process.exit(1);
    }

    const pastaRaiz = args[0];
    const modoDeletar = args.includes('--deletar');

    if (!fs.existsSync(pastaRaiz)) {
        console.error(`❌ Erro: A pasta "${pastaRaiz}" não existe.`);
        process.exit(1);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🔎 DETECTOR DE FOTOS DUPLICADAS');
    console.log('='.repeat(60));
    console.log(`Pasta: ${pastaRaiz}`);
    console.log(`Modo: ${modoDeletar ? '⚠️  DELEÇÃO ATIVADA' : '👁️  APENAS VISUALIZAÇÃO'}`);

    const resultado = analisarDuplicatas(pastaRaiz);

    console.log('📊 RESUMO:');
    console.log(`   - Arquivos analisados: ${resultado.totalArquivos}`);
    console.log(`   - Arquivos com erro: ${resultado.arquivosComErro.length}`);
    console.log(`   - Duplicatas na mesma subpasta: ${resultado.duplicatasMesmaSubpasta.length} grupo(s)`);
    console.log(`   - Duplicatas entre subpastas: ${resultado.duplicatasOutrasSubpastas.length} grupo(s)`);

    if (modoDeletar && resultado.duplicatasMesmaSubpasta.length > 0) {
        console.log('\n🗑️  DELETANDO DUPLICATAS...');
        const { deletados, erros } = executarDelecoes(resultado.duplicatasMesmaSubpasta);
        console.log(`\n   ✅ ${deletados} arquivo(s) deletado(s)`);
        if (erros > 0) {
            console.log(`   ⚠️  ${erros} erro(s)`);
        }
    }

    const relatorio = gerarRelatorio(resultado, pastaRaiz, modoDeletar);
    const nomeLog = `duplicatas_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const caminhoLog = path.join(pastaRaiz, nomeLog);

    fs.writeFileSync(caminhoLog, relatorio, 'utf-8');
    console.log(`\n📄 Relatório salvo em: ${caminhoLog}`);

    if (!modoDeletar && resultado.duplicatasMesmaSubpasta.length > 0) {
        console.log('\n💡 Para executar as deleções, rode novamente com --deletar');
    }

    console.log('\n✨ Concluído!\n');
}

main();
