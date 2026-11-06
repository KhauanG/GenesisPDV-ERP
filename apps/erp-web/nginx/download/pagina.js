// Página de download do PDV (README de infra/producao › Página de download do PDV). Lê /pdv/atual.json, que a
// Implantação grava a partir do último GitHub Release do PDV (só depois de conferir o sha256), e mostra o botão com a
// versão, o tamanho e o sha256. Sem o arquivo (404), "ainda não foi publicado". Só textContent e atributos (nada de
// innerHTML) e só valores no formato esperado: o JSON vem do servidor, mas a página não confia nele para montar HTML.
'use strict';

(function () {
  const RE_VERSAO = /^\d+\.\d+\.\d+$/;
  const RE_SHA256 = /^[0-9a-f]{64}$/;

  function mostrar(id) {
    for (const outro of ['carregando', 'nao-publicado', 'erro', 'publicado']) {
      document.getElementById(outro).hidden = outro !== id;
    }
  }

  function texto(id, valor) {
    document.getElementById(id).textContent = valor;
  }

  function valido(atual) {
    return (
      atual !== null &&
      typeof atual === 'object' &&
      typeof atual.versao === 'string' &&
      RE_VERSAO.test(atual.versao) &&
      atual.arquivo === 'GenesisPDV-Setup-' + atual.versao + '.exe' &&
      typeof atual.sha256 === 'string' &&
      RE_SHA256.test(atual.sha256) &&
      Number.isSafeInteger(atual.tamanho_bytes) &&
      atual.tamanho_bytes > 0
    );
  }

  function tamanho(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' MB';
  }

  function data(iso) {
    const d = new Date(typeof iso === 'string' ? iso : '');
    if (Number.isNaN(d.getTime())) return '';
    return '(publicada em ' + d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ')';
  }

  function exibir(atual) {
    const caminho = '/pdv/' + encodeURIComponent(atual.arquivo);
    texto('versao', atual.versao);
    texto('data', data(atual.publicado_em));
    texto('arquivo', atual.arquivo);
    texto('tamanho', tamanho(atual.tamanho_bytes));
    texto('sha256', atual.sha256);
    texto(
      'comando-conferir',
      '(Get-FileHash "$HOME\\Downloads\\' + atual.arquivo + '").Hash -eq \'' + atual.sha256 + "'",
    );
    const baixar = document.getElementById('baixar');
    baixar.href = caminho;
    baixar.setAttribute('download', atual.arquivo);
    document.getElementById('link-sha256').href = caminho + '.sha256';
    document.title = 'GenesisPDV ' + atual.versao + ' · Download';
    mostrar('publicado');
  }

  async function carregar() {
    let resposta;
    try {
      resposta = await fetch('/pdv/atual.json', { cache: 'no-store' });
    } catch {
      mostrar('erro');
      return;
    }
    if (resposta.status === 404) {
      mostrar('nao-publicado');
      return;
    }
    if (!resposta.ok) {
      mostrar('erro');
      return;
    }
    let atual;
    try {
      atual = await resposta.json();
    } catch {
      mostrar('erro');
      return;
    }
    if (valido(atual)) exibir(atual);
    else mostrar('erro');
  }

  carregar();
})();
