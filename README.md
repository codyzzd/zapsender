# Zapsender

**Extensão Chrome para fila de mensagens no WhatsApp Web — sem Playwright, sem automação externa.**

Zapsender permite importar listas de contatos (CSV), compor templates de mensagens com variáveis personalizadas (`{nome}`, `{telefone}`) e enviá-las em massa pelo WhatsApp Web diretamente de dentro do navegador.

---

## Funcionalidades

- **Importação de contatos via CSV** — com detecção automática de delimitador (vírgula, ponto e vírgula, tab) e normalização de números brasileiros (DDI/DDD)
- **Múltiplas campanhas** — crie, renomeie, duplique e gerencie campanhas independentes
- **Templates de mensagens** — suporte a múltiplas versões de texto por campanha; no modo Auto, uma versão aleatória é escolhida para cada contato
- **Variáveis nos templates** — `{nome}` e `{telefone}` são substituídos automaticamente
- **4 formatos de nome** — original, inverter separando por vírgula, primeiro nome + último sobrenome, apenas primeiro nome
- **Anexos** — imagens, vídeos, áudios, PDFs, documentos até 50 MB, por campanha ou por versão de mensagem
- **Modo Áudio/Voz** — envio como arquivo de áudio ou como mensagem de voz (experimental)
- **3 modos de envio:**
  - **Manual** — abre a conversa e você envia manualmente
  - **Assistido** — abre a próxima conversa automaticamente após você marcar como enviado
  - **Auto** — envia automaticamente sem alterar a conversa visível no WhatsApp Web
- **Intervalo aleatório** — delay configurável entre envios (mín/máx em segundos)
- **Estatísticas em tempo real** — total, pendentes, abertos, enviados, pulados, erros
- **Barra de progresso** com estimativa de tempo restante (ETA)
- **Pular contato** durante o envio
- **Resetar progresso** da campanha
- **Exportar relatório CSV** — completo ou apenas sucessos
- **Backup e restauração** — exporta/importa campanhas completas em JSON (com opção de substituir ou mesclar)
- **Notificação sonora** — alerta quando uma conversa está pronta

---

## Como funciona

### Arquitetura

O Zapsender é dividido em três camadas que se comunicam dentro do navegador:

```
┌─────────────────────┐
│   Service Worker     │  Gerencia abas, roteia mensagens,
│  (service-worker.js) │  transfere anexos em chunks via IndexedDB
└────────┬────────────┘
         │
    chrome.runtime.connect / chrome.tabs.connect
         │
┌────────v────────────┐
│  Painel (Panel)      │  Interface com o usuário (panel.html + panel.js)
│  (chrome-extension)  │  Importa CSV, gerencia estado, exibe stats
└─────────────────────┘
         │
    chrome.tabs.connect
         │
┌────────v──────────────────────┐
│  WhatsApp Web Tab              │
│  ┌─────────────────────────┐   │
│  │ whatsapp-content.js      │   │  Mundo ISOLATED — bridge service worker ↔ main
│  │ (ISOLATED world)         │   │
│  └────────┬────────────────┘   │
│           │ window.postMessage │
│  ┌────────v────────────────┐   │
│  │ whatsapp-main.js         │   │  Mundo MAIN — engine de envio
│  │ wwebjs-utils.js          │   │  Acessa módulos internos do WhatsApp Web
│  │ (MAIN world)             │   │
│  └────────┬────────────────┘   │
│           │                    │
│           v                    │
│   Módulos internos do WhatsApp │  window.require() → WAWebCollections, etc.
└────────────────────────────────┘
```

### Chave técnica: injeção no runtime do WhatsApp Web

O WhatsApp Web carrega seus módulos via um sistema AMD internamente exposto por `window.require()`. O Zapsender injeta dois scripts no **MAIN world** da página (`whatsapp-main.js` e `wwebjs-utils.js`) para acessar esses módulos diretamente — sem precisar digitar no campo de texto ou simular cliques.

O que o código injetado faz:
1. **Verifica se o número existe no WhatsApp** — via `WAWebQueryExistsJob`
2. **Encontra ou cria a conversa** — via `WAWebCollections.Chat`
3. **Envia a mensagem** — via `WAWebSendMsgChatAction` (texto) ou `WAWebPrepRawMedia` + `WAWebMediaMmsV4Upload` (mídia)
4. **Gerencia o upload de anexos** — arquivos são transferidos do IndexedDB da extensão para o contexto da página em chunks de 256 KB

Como a extensão usa o runtime real do WhatsApp Web, não há dependência de Playwright, Puppeteer ou qualquer ferramenta externa — tudo roda dentro do próprio navegador.

---

## Créditos

### whatsapp-web.js

Grande parte da capacidade de interagir com os módulos internos do WhatsApp Web vem do projeto **whatsapp-web.js** ([github.com/wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js)), licenciado sob Apache 2.0.

O arquivo `content/injected/wwebjs-utils.js` é derivado de `src/util/Injected/Utils.js` do wwebjs, adaptado de módulo Node.js para função global do navegador (`window.ZapsenderLoadWWebUtils`). O código originalmente escrito pela comunidade wwebjs provê os wrappers que chamam os módulos internos do WhatsApp Web (`sendMessage`, `processMediaData`, `getChat`, etc.).

- Repositório: [github.com/wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js)
- Licença: [Apache 2.0](third_party/WHATSAPP_WEB_JS_LICENSE.txt)
- Revisão pinada: `2dc9466facb027caee19dbf285e0a2763f5373bb`

### Demais componentes

Todo o restante do código — interface, gerenciamento de estado, parser CSV, normalização de telefone, fila de mensagens, sistema de campanhas, backup/restore, integração com Chrome APIs — foi escrito originalmente para este projeto.

---

## Instalação

1. Faça o clone do repositório
2. Abra o Chrome em `chrome://extensions`
3. Ative o **Modo do desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto
5. Acesse [web.whatsapp.com](https://web.whatsapp.com) e escaneie o QR Code normalmente
6. Clique no ícone da extensão na barra de ferramentas para abrir o painel

---

## Desenvolvimento

```bash
# Verificar sintaxe de todos os arquivos JS
npm run check

# Rodar testes
npm test

# Sincronizar wwebjs-utils.js com a versão mais recente do wwebjs
npm run sync:wwebjs
```

---

## Aviso

Este projeto não tem nenhuma afiliação com o WhatsApp ou Meta. O uso de automação no WhatsApp pode violar os Termos de Serviço da plataforma. Use por sua conta e risco.
