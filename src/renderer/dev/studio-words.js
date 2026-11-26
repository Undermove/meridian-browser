/* Meridian Studio — its words, in Russian and English, and what each of Claude Code's steps is
 * called in plain words (no tool names, commands or paths unless the person opens the details).
 * Pure: node tests require it.
 */
(function (root) {
  'use strict';

  const T = {
    ru: {
      studio: 'Студия', workbench: 'Workbench', tasks: 'Задачи', newTask: 'Новая задача',
      placeholder: 'Напишите, что сделать…', send: 'Отправить', stop: 'Остановить',
      claude: 'Claude', you: 'Вы', minutes: (n) => (n < 1 ? 'только что' : n < 60 ? `${n} мин` : `${Math.floor(n / 60)} ч`),
      pickFolder: 'Выберите папку для работы', pickFolderHint: 'Claude будет работать с копиями ваших файлов в этой папке — оригиналы не тронет.',
      chooseFolder: 'Выбрать папку', recent: 'Недавние',
      emptyTitle: 'Что сделаем?', emptyHint: 'Напишите задачу своими словами или выберите подсказку. Claude покажет каждый шаг, спросит разрешения и ничего не отправит наружу без вас.',
      roles: { designer: 'Дизайнер:', manager: 'Менеджер:', developer: 'Разработчику:', everyday: 'Можно так:' },
      chips: {
        designer: ['Перекрась сайт под наш бренд', 'Собери референсы в доску', 'Найди несостыковки в макете'],
        manager: ['Сделай отчёт по задачам за неделю', 'Сравни два документа', 'Подготовь повестку встречи'],
        developer: ['Найди и почини баг на странице', 'Объясни, как устроен этот проект'],
        everyday: ['Сделай сайт удобнее для чтения', 'Собери заметки из этих страниц'],
      },
      allow: 'Разрешить', once: 'Только в этот раз', no: 'Нет', allowed: 'Разрешено', denied: 'Не разрешено',
      answerInWorkbench: 'Ответить можно в Workbench', openWorkbench: 'Открыть Workbench',
      filesTitle: 'Файлы по ходу работы', created: 'новый', changed: 'изменён', shot: 'скриншот', shots: 'Снимки',
      siteBar: 'Результат', showSite: 'Показать живой сайт рядом', lastShot: 'последний снимок', boostUndo: 'Boost · можно отменить', boostUndone: 'Вернули как было',
      before: 'До', after: 'После', undo: 'Отменить', undoTitle: 'Вернуть сайт как был до задачи',
      working: 'Работаю…', waiting: 'Ждёт вас', done: 'Готово', idle: 'Готово',
      busy: 'Claude ещё работает — отправлю, когда закончит.', queued: 'В очереди',
      startedInWorkbench: 'Задача начата в Workbench: правила черновиков в ней не включены.',
      step: (i, n) => `шаг ${i} из ${n}`, noFiles: 'Здесь появятся файлы, которые Claude создаст или поменяет.',
      resultEmpty: 'Здесь будет результат: сайт, картинки и документы, которые получатся.',
      openFile: 'Показать в папке', taskFallback: 'Новая задача', notStarted: 'Не удалось запустить Claude',
      details: 'Подробнее', consent: 'Задачи выполняет Claude от Anthropic: то, что вы пишете, и файлы, которые он смотрит, уходят в Anthropic.',
      consentOk: 'Понятно, начать',
      trustTitle: 'Разрешить Claude работать в этой папке?', trustDetail: (n) => `Claude будет смотреть файлы в папке ${n} и спрашивать, прежде чем что-то поменять.`,
    },
    en: {
      studio: 'Studio', workbench: 'Workbench', tasks: 'Tasks', newTask: 'New task',
      placeholder: 'Say what to do…', send: 'Send', stop: 'Stop',
      claude: 'Claude', you: 'You', minutes: (n) => (n < 1 ? 'just now' : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h`),
      pickFolder: 'Pick a folder to work in', pickFolderHint: 'Claude works on copies of your files in this folder and leaves the originals as they are.',
      chooseFolder: 'Choose a folder', recent: 'Recent',
      emptyTitle: 'What shall we make?', emptyHint: 'Describe the task in your own words or pick a suggestion. Claude shows every step, asks before it changes things and never sends anything out without you.',
      roles: { designer: 'Designer:', manager: 'Manager:', developer: 'Developer:', everyday: 'Try:' },
      chips: {
        designer: ['Restyle our site in our brand', 'Collect references into a board', 'Find inconsistencies in the mockup'],
        manager: ['Write a weekly report from our tasks', 'Compare two documents', 'Prepare a meeting agenda'],
        developer: ['Find and fix a bug on the page', 'Explain how this project works'],
        everyday: ['Make the site easier to read', 'Collect notes from these pages'],
      },
      allow: 'Allow', once: 'Just this once', no: 'No', allowed: 'Allowed', denied: 'Not allowed',
      answerInWorkbench: 'This one is answered in the Workbench', openWorkbench: 'Open Workbench',
      filesTitle: 'Files from this task', created: 'new', changed: 'changed', shot: 'screenshot', shots: 'Snapshots',
      siteBar: 'Result', showSite: 'Show the live site alongside', lastShot: 'latest snapshot', boostUndo: 'Boost · can be undone', boostUndone: 'Back as it was',
      before: 'Before', after: 'After', undo: 'Undo', undoTitle: 'Put the site back as it was before the task',
      working: 'Working…', waiting: 'Needs you', done: 'Done', idle: 'Done',
      busy: 'Claude is still working — I’ll send it when it’s done.', queued: 'Queued',
      startedInWorkbench: 'This task started in the Workbench: the drafts rules aren’t on in it.',
      step: (i, n) => `step ${i} of ${n}`, noFiles: 'Files Claude creates or changes show up here.',
      resultEmpty: 'The result shows here: the site, pictures and documents it makes.',
      openFile: 'Show in folder', taskFallback: 'New task', notStarted: 'Couldn’t start Claude',
      details: 'Details', consent: 'Tasks are done by Claude from Anthropic: what you write and the files it looks at go to Anthropic.',
      consentOk: 'Got it, start',
      trustTitle: 'Let Claude work in this folder?', trustDetail: (n) => `Claude will look at the files in ${n} and ask before it changes anything.`,
    },
  };

  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');
  const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // [icon, done text, doing text] for a step, in `lang`.
  function stepWords(tool, input, lang) {
    const ru = lang === 'ru';
    const i = input || {};
    const f = base(i.file_path || i.notebook_path || i.path);
    const site = host(i.url);
    const say = (icon, r, e, rNow, eNow) => [icon, ru ? r : e, ru ? (rNow || r) : (eNow || e)];
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
    if (mcp) {
      const server = mcp[1].toLowerCase(), name = mcp[2];
      if (server.includes('meridian')) {
        switch (name) {
          case 'navigate': case 'open_tab': return say('globe', `Открыл сайт ${site}`.trim(), `Opened ${site || 'a site'}`, `Открываю ${site}`.trim(), `Opening ${site || 'a site'}`);
          case 'screenshot': return say('eye', 'Снял скриншот', 'Took a screenshot', 'Снимаю скриншот', 'Taking a screenshot');
          case 'read_page': case 'get_interactive_elements': return say('file', 'Прочитал страницу', 'Read the page', 'Читаю страницу', 'Reading the page');
          case 'set_boost': return say('palette', 'Применил новый стиль к сайту', 'Restyled the site', 'Применяю стиль к сайту', 'Restyling the site');
          case 'get_boost': return say('palette', 'Посмотрел текущий стиль сайта', 'Checked the site’s style');
          case 'click': return say('sparkles', 'Нажал на странице', 'Clicked on the page');
          case 'type_text': return say('pencil', 'Ввёл текст на странице', 'Typed on the page');
          case 'scroll': return say('sparkles', 'Прокрутил страницу', 'Scrolled the page');
          case 'list_tabs': case 'search_tabs': return say('layers', 'Посмотрел открытые вкладки', 'Looked at the open tabs');
          case 'split_view': return say('layers', 'Открыл страницы рядом', 'Put pages side by side');
          case 'translate_page': return say('globe', 'Перевёл страницу', 'Translated the page');
          case 'wait_for': return say('history', 'Подождал, пока страница загрузится', 'Waited for the page');
          default: return say('globe', 'Сделал шаг в браузере', 'Did a step in the browser');
        }
      }
      if (server.includes('figma')) return say('palette', 'Посмотрел макет в Figma', 'Looked at the Figma file', 'Смотрю макет в Figma', 'Looking at the Figma file');
      return say('puzzle', 'Воспользовался подключённым сервисом', 'Used a connected service');
    }
    switch (tool) {
      case 'Read': case 'NotebookRead': return say('file', `Посмотрел ${f || 'файл'}`, `Looked at ${f || 'a file'}`, `Смотрю ${f || 'файл'}`, `Looking at ${f || 'a file'}`);
      case 'Write': return say('pencil', `Создал ${f}`, `Created ${f}`, `Создаю ${f}`, `Creating ${f}`);
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return say('pencil', `Поменял ${f}`, `Changed ${f}`, `Меняю ${f}`, `Changing ${f}`);
      case 'Glob': case 'Grep': case 'LS': return say('search', 'Поискал по файлам', 'Searched the files', 'Ищу по файлам', 'Searching the files');
      case 'WebFetch': return say('globe', `Открыл страницу ${site}`.trim(), `Opened ${site || 'a page'}`, `Открываю ${site}`.trim(), `Opening ${site || 'a page'}`);
      case 'WebSearch': return say('search', `Поискал в интернете: ${clip(i.query, 40)}`, `Searched the web: ${clip(i.query, 40)}`);
      case 'TodoWrite': return say('layers', 'Составил план', 'Made a plan');
      case 'Task': case 'Agent': return say('sparkles', `Позвал помощника: ${clip(i.description, 40)}`, `Asked a helper: ${clip(i.description, 40)}`);
      case 'Bash': case 'PowerShell': {
        const d = clip(i.description, 56);
        return d ? say('wand', d, d) : say('wand', 'Выполнил действие на компьютере', 'Ran a step on the computer', 'Выполняю действие', 'Running a step');
      }
      case 'ExitPlanMode': return say('layers', 'Предложил план', 'Proposed a plan');
      case 'AskUserQuestion': return say('chat', 'Задал вопрос', 'Asked a question');
      default: return say('sparkles', ru ? 'Сделал шаг' : 'Did a step', 'Did a step');
    }
  }

  // A permission question in plain words: [title, detail].
  function askWords(tool, summary, lang) {
    const ru = lang === 'ru';
    const s = String(summary || '');
    const parts = s.split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts[parts.length - 2] : '';
    const file = parts[parts.length - 1] || '';
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool || '');
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) {
      return ru
        ? [folder ? `Разрешить менять файлы в папке ${folder}?` : `Разрешить поменять ${file}?`, `${tool === 'Write' ? 'Создам' : 'Поменяю'} ${file}. Оригиналы не трогаю — всё можно вернуть.`]
        : [folder ? `Allow changing files in ${folder}?` : `Allow changing ${file}?`, `${tool === 'Write' ? 'I’ll create' : 'I’ll change'} ${file}. Originals stay as they are — everything can be undone.`];
    }
    if (mcp && mcp[1].toLowerCase().includes('meridian')) {
      const n = mcp[2];
      if (n === 'set_boost') return ru ? ['Разрешить перекрасить сайт?', 'Это Boost: меняется только вид у вас в браузере, его можно отменить одной кнопкой.'] : ['Allow restyling the site?', 'It’s a Boost: only how it looks in your browser changes, and one button undoes it.'];
      if (n === 'navigate' || n === 'open_tab') return ru ? ['Разрешить открыть сайт?', s] : ['Allow opening a site?', s];
      if (n === 'click' || n === 'type_text') return ru ? ['Разрешить действовать на странице?', 'Claude нажмёт или введёт текст на открытой странице.'] : ['Allow acting on the page?', 'Claude will click or type on the open page.'];
      return ru ? ['Разрешить действие в браузере?', ''] : ['Allow a step in the browser?', ''];
    }
    if (mcp && mcp[1].toLowerCase().includes('figma')) return ru ? ['Разрешить посмотреть макет в Figma?', 'Только чтение: в Figma ничего не меняется.'] : ['Allow reading the Figma file?', 'Read only: nothing changes in Figma.'];
    if (tool === 'Bash' || tool === 'PowerShell') return ru ? ['Разрешить действие на компьютере?', 'Claude хочет выполнить команду — подробности в «Подробнее».'] : ['Allow a step on the computer?', 'Claude wants to run a command — see Details.'];
    if (tool === 'WebFetch') return ru ? ['Разрешить открыть страницу?', s] : ['Allow opening a page?', s];
    if (tool === 'Read') return ru ? [`Разрешить посмотреть ${file}?`, ''] : [`Allow looking at ${file}?`, ''];
    return ru ? ['Разрешить следующий шаг?', ''] : ['Allow the next step?', ''];
  }

  const api = { T, stepWords, askWords, host };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StudioWords = api;
})(typeof window !== 'undefined' ? window : globalThis);
