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
      ago: (n) => {
        if (n < 1) return 'только что';
        if (n < 60) return `${n} мин назад`;
        const h = Math.floor(n / 60);
        if (h < 24) return `${h} ч назад`;
        const d = Math.floor(h / 24);
        if (d === 1) return 'вчера';
        const w = d % 10 === 1 && d % 100 !== 11 ? 'день' : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? 'дня' : 'дней';
        return `${d} ${w} назад`;
      },
      earlier: 'Показать раньше', allFiles: (n) => `Показать все (${n})`,
      homeFailed: 'Не получилось создать папку для задач', retry: 'Попробовать ещё раз',
      ownFiles: 'Работать с моими файлами…', ownChange: 'Другая папка…', backHome: 'Вернуться в Meridian Studio',
      ownTitle: 'Работать с вашими файлами', ownHint: 'Выберите папку с файлами. Claude будет работать с копиями файлов из этой папки, оригиналы не тронет.', ownPick: 'Выбрать папку',
      inFolder: (n) => `Папка «${n}»`, reveal: 'Показать в Finder', more: 'Ещё',
      emptyTitle: 'Что сделаем?', emptyHint: 'Напишите задачу своими словами или выберите подсказку. Claude покажет каждый шаг, спросит разрешения и ничего не отправит наружу без вас.',
      roles: { designer: 'Дизайнер:', manager: 'Менеджер:', developer: 'Разработчику:', everyday: 'Можно так:' },
      // Starters: each one complete, with what it needs asked inline and a result you see.
      // need: 'site' (an open tab or an address) | 'text' (a few words) | '' (runs at once).
      starters: {
        designer: [
          { id: 'restyle', label: 'Перекрась сайт под наш бренд', need: 'site', ask: 'Какой сайт перекрасить?',
            prompt: (v) => `Перекрась сайт ${v} под наш бренд. Открой его в браузере (он уже открыт рядом со Studio), сделай скриншот «до». Возьми цвета и шрифты из brand.json в этой папке; если его нет — возьми основной цвет из логотипа сайта и собери из него спокойную палитру. Перекрась через Boost этого сайта (set_boost, только CSS), сделай скриншот «после». В конце в 2–3 строках скажи, что поменял.` },
          { id: 'board', label: 'Собери референсы в доску', need: 'text', ask: 'О чём доска?', placeholder: 'например: кофейни в скандинавском стиле',
            prompt: (v) => `Собери доску референсов на тему «${v}». Найди в интернете 9–12 хороших примеров (сайты, интерьеры, упаковка — что подходит теме). Сделай в папке «Черновики» файл board.html: сетка карточек — картинка (по прямой ссылке на изображение), короткая подпись, чем пример хорош, и ссылка на источник; светлый фон, аккуратная типографика. Ничего не публикуй. В конце одной строкой скажи, что получилось.` },
          { id: 'audit', label: 'Найди несостыковки на странице', need: 'site', ask: 'Какую страницу проверить?',
            prompt: (v) => `Проверь страницу ${v} (она открыта рядом со Studio) на несостыковки дизайна: разные оттенки одного цвета, разные шрифты и размеры у одинаковых элементов, разные отступы и скругления у похожих блоков, кнопки разного вида. Каждую найденную отметь на странице пином: [[pin: <CSS-селектор> | <что не так, коротко>]] — не больше 12. Ничего не меняй. В конце дай список по важности.` },
        ],
        manager: [
          { id: 'report', label: 'Сделай отчёт по задачам за неделю', need: 'text', ask: 'Откуда взять задачи?', placeholder: 'ссылка на доску или пара слов',
            prompt: (v) => `Сделай отчёт за неделю по задачам: ${v}. Сделай в папке «Черновики» файл report.html: что сделано, что в работе, что мешает, на одну страницу, без жаргона. Ничего никуда не отправляй.` },
          { id: 'compare', label: 'Сравни два документа', need: 'text', ask: 'Какие два документа?', placeholder: 'ссылки или названия файлов',
            prompt: (v) => `Сравни два документа: ${v}. Сделай в папке «Черновики» файл compare.html: они рядом, различия подсвечены, сверху — короткий итог, что поменялось.` },
          { id: 'agenda', label: 'Подготовь повестку встречи', need: 'text', ask: 'О чём встреча?', placeholder: 'тема и кто будет',
            prompt: (v) => `Подготовь повестку встречи: ${v}. Сделай в папке «Черновики» файл agenda.html: цель, пункты со временем, кто что готовит, решения, которые нужно принять.` },
        ],
        developer: [
          { id: 'bug', label: 'Найди и почини баг на странице', need: 'site', ask: 'На какой странице?',
            prompt: (v) => `На странице ${v} (она открыта рядом со Studio) найди, что сломано: ошибки в консоли, то, что не работает или съехало. Покажи пином [[pin: <селектор> | <что не так>]] и предложи исправление; если это наш проект в этой папке — поправь копию в «Черновиках».` },
          { id: 'explain', label: 'Объясни, как устроен этот проект', need: '',
            prompt: () => 'Объясни простыми словами, как устроен проект в этой папке. Сделай в папке «Черновики» файл overview.html: из чего он состоит, как части связаны (схема), откуда начать читать.' },
        ],
        everyday: [
          { id: 'read', label: 'Сделай сайт удобнее для чтения', need: 'site', ask: 'Какой сайт?',
            prompt: (v) => `Сделай сайт ${v} удобнее для чтения через Boost (только CSS): крупнее текст, спокойнее фон, шире межстрочный, убери отвлекающее. Скриншоты до и после.` },
          { id: 'notes', label: 'Собери заметки из этих страниц', need: 'site', ask: 'Из какой страницы?',
            prompt: (v) => `Собери главное со страницы ${v} в заметку: сделай в папке «Черновики» файл notes.html — суть в 5–7 пунктах, цитаты со ссылками.` },
        ],
      },
      starterGo: 'Начать', starterOther: 'Другой адрес…', starterNoTabs: 'Откройте сайт во вкладке или вставьте адрес', starterCancel: 'Отмена',
      chips: {
        designer: ['Перекрась сайт под наш бренд', 'Собери референсы в доску', 'Найди несостыковки на странице'],
        manager: ['Сделай отчёт по задачам за неделю', 'Сравни два документа', 'Подготовь повестку встречи'],
        developer: ['Найди и почини баг на странице', 'Объясни, как устроен этот проект'],
        everyday: ['Сделай сайт удобнее для чтения', 'Собери заметки из этих страниц'],
      },
      allow: 'Разрешить', once: 'Только в этот раз', no: 'Нет', allowed: 'Разрешено', denied: 'Не разрешено',
      answerInWorkbench: 'Ответить можно в Workbench', openWorkbench: 'Открыть Workbench',
      trustFailed: 'Не получилось ответить на вопрос о папке — ответьте в Workbench',
      allowOnce: 'Разрешить', allowTask: 'Разрешить всегда для этой задачи', whyAsk: 'Почему спрашиваем?',
      qAsks: 'Claude спрашивает', qOwn: 'Своими словами — в Workbench', qSend: 'Ответить', qAnswered: 'Ответ',
      filesTitle: 'Файлы по ходу работы', created: 'новый', changed: 'изменён', shot: 'скриншот', shots: 'Снимки', shotBefore: 'Было', shotAfter: 'Стало', wipeHint: 'было ← шторка → стало',
      siteBar: 'Результат', showSite: 'Показать живой сайт рядом', lastShot: 'последний снимок', boostUndo: 'Boost · можно отменить', boostUndone: 'Вернули как было',
      before: 'До', after: 'После', undo: 'Отменить', undoTitle: 'Вернуть сайт как был до задачи',
      working: 'Работаю…', waiting: 'Ждёт вас', done: 'Готово', idle: 'Готово',
      busy: 'Claude ещё работает — отправлю, когда закончит.', queued: 'В очереди',
      startedInWorkbench: 'Начато в Workbench: здесь Claude правит файлы сразу, без черновиков.',
      showPage: 'Открыть рядом', pageAlongside: 'Открыта рядом со Студией — меняется вместе с задачей.', outsideFolder: 'Этот файл лежит вне папки задачи: показать его здесь не получится.',
      splitter: 'Ширина чата', tasksSplitter: 'Ширина списка задач', splitterHint: 'Потяните, чтобы изменить ширину; двойной щелчок — как было', taskView: 'Задача',
      step: (i, n) => `шаг ${i} из ${n}`, noFiles: 'Здесь появятся файлы, которые Claude создаст или поменяет.',
      resultEmpty: 'Здесь будет результат: сайт, картинки и документы, которые получатся.',
      openFile: 'Показать в папке', taskFallback: 'Без названия', notStarted: 'Не удалось запустить Claude',
      details: 'Подробнее', consent: 'Задачи выполняет Claude от Anthropic: то, что вы пишете, и файлы, которые он смотрит, уходят в Anthropic.',
      consentOk: 'Понятно, начать',
      point: 'Ткни и скажи', pointTitle: 'Покажите на странице, что поменять: скажите словами или поправьте руками', pointNoSite: 'Сначала откройте сайт рядом',
      pointChip: 'Показать на странице', pickTitle: 'Выбрать элемент на странице — сообщение будет про него', unpick: 'Убрать выбор',
      pinYes: (n, t) => `Да, сделай то, что ты предложил в пине ${n}: ${t}`, andMore: (n) => `и ещё ${n}`,
      handTitle: 'Вы поправили руками:', handNext: 'Claude узнает об этом со следующим сообщением.',
      handPrompt: (host, lines) => `Я поправил руками на странице ${host} (это уже в Boost «Studio · ${host}», не перезаписывай и учитывай дальше):\n${lines}`,
      sayPrompt: (host, list, text) => `На странице ${host} я показал на:\n${list}\n\n${text}\n\nМеняй только это (через Boost на этом сайте), остальное не трогай.`,
      brand: 'Бренд', fromSite: 'с сайта', readOnly: 'только смотрю', palette: 'Палитра', fonts: 'Шрифты', fontSample: 'Свежий кофе', headings: 'заголовки', bodyText: 'текст', remove: 'Убрать',
      brandNone: 'Бренд ещё не задан', brandNoneHint: 'Студия будет красить только цветами бренда и замечать, что на сайте из него выбивается.',
      brandFromSite: (h) => `Взять цвета и шрифты с ${h}`, brandNeedSite: 'Сначала откройте сайт в задаче', brandRetake: 'Взять заново с сайта', brandNoColors: 'На странице не нашлось цветов',
      brandCheck: 'Проверить сайт по бренду', brandAllGood: 'Всё на странице — в цветах бренда.',
      driftTitle: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'цвет' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'цвета' : 'цветов'} на сайте не из бренда — заменить?`,
      driftFix: 'Заменить все', driftWhere: 'Показать где', driftKeep: 'Оставить',
      figmaOff: 'не подключена', figmaOn: 'подключена', figmaNotRunning: 'не подключена — Figma не отвечает', figmaOpen: 'Открыть Figma',
      figmaLinkHint: 'Вставьте ссылку на файл с цветами и шрифтами (Styles / Variables)',
      siteAddress: 'Адрес сайта', takeFromSite: 'Забрать с сайта', siteBad: 'Нужен адрес сайта, например zerno.coffee', figmaConnect: 'Подключить Figma', figmaLink: 'Ссылка на файл бренда в Figma', figmaTake: 'Взять бренд',
      figmaHow: 'Откройте Figma на этом компьютере и один раз включите: меню Figma → Настройки → Dev Mode MCP Server. Студия только читает макеты.',
      figmaBadLink: 'Нужна ссылка вида https://www.figma.com/…',
      figmaPrompt: (l) => `Возьми бренд из Figma (только читай, ничего в Figma не меняй): ${l}\nНайди цвета и шрифты бренда (переменные и стили) и запиши их в brand.json в этой папке так: {"source":"figma","name":"<название>","colors":[{"name":"<имя>","value":"#RRGGBB"}],"fonts":[{"family":"<шрифт>","use":"head" или "text"}]}. Коротко скажи, что нашёл.`,
      cards: 'Карточки', chat: 'Чат', allTasks: 'Все задачи', all: 'Все', inWork: 'В работе', look: 'Посмотреть',
      handoff: 'Передать разработчику', handoffHint: 'Соберу описание и изменения, чтобы передать разработчику — ничего не отправлю без вашего «да»', ownWords: 'Или своими словами…',
      taskCount: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'задача' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'задачи' : 'задач'}`,
      needsCount: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'ждёт' : 'ждут'} вас`, filesCount: (n) => `Файлов: ${n}`,
      handoffPrompt: 'Подготовь это для разработчиков: в папке «Черновики» собери handoff.md — что поменяли и зачем, скриншоты до и после, точные цвета, шрифты и отступы, и какие файлы сайта это затронет. Если это сайт в git-репозитории — подготовь ветку с правками и черновик pull request, но ничего не отправляй и не публикуй без моего «да». Пиши без жаргона.',
      whoTitle: 'Кто вы?', whoLead: 'Выберите героя — Meridian подстроится под вашу работу. Поменять можно в любой момент.', skip: 'Пропустить',
      whoNote: 'Догадка — по приложениям на этом компьютере. Никуда не отправляется.', whoChange: 'Студия и Workbench всегда в один клик — выбор решает, что открывается первым.',
      guess: 'Похоже на вас', roleChange: 'Кто вы? Поменять роль',
      personas: {
        developer: { name: 'Разработчик', cls: 'Нетраннер', role: 'код и агенты', perks: [['term', 'Код и терминал в Workbench'], ['cursor', 'Агенты водят браузер'], ['grid', 'Все агенты — в Mission Control']], gets: 'Откроется <b>Workbench</b>', cta: 'Я разработчик — дальше' },
        designer: { name: 'Дизайнер', cls: 'Чародейка', role: 'макеты и сайты', perks: [['brush', 'Правки словами на сайте'], ['drop', 'Бренд из Figma не уплывёт'], ['undo', 'Любую правку можно отменить']], gets: 'Откроется <b>Студия</b>', cta: 'Я дизайнер — дальше' },
        manager: { name: 'Менеджер', cls: 'Волшебница', role: 'задачи и отчёты', perks: [['doc', 'Отчёт из задач на глазах'], ['shield', 'Наружу — только после «да»'], ['split', 'Работа и личное — раздельно']], gets: 'Откроется <b>Студия</b>', cta: 'Я менеджер — дальше' },
        everyday: { name: 'Просто пользуюсь', cls: 'Путешественник', role: 'сайты и почта', perks: [['tabs', 'Вкладки сами в порядке'], ['search', 'Поиск по открытым вкладкам'], ['spark', 'AI — только по просьбе']], gets: 'Откроется <b>Студия</b>, без лишнего', cta: 'Просто пользуюсь — дальше' },
      },
      trustTitle: 'Разрешить Claude работать в этой папке?', trustDetail: (n) => `Claude будет смотреть файлы в папке ${n} и спрашивать, прежде чем что-то поменять.`,
    },
    en: {
      studio: 'Studio', workbench: 'Workbench', tasks: 'Tasks', newTask: 'New task',
      placeholder: 'Say what to do…', send: 'Send', stop: 'Stop',
      claude: 'Claude', you: 'You', minutes: (n) => (n < 1 ? 'just now' : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h`),
      ago: (n) => {
        if (n < 1) return 'just now';
        if (n < 60) return `${n} min ago`;
        const h = Math.floor(n / 60);
        if (h < 24) return `${h} h ago`;
        const d = Math.floor(h / 24);
        return d === 1 ? 'yesterday' : `${d} days ago`;
      },
      earlier: 'Show earlier', allFiles: (n) => `Show all (${n})`,
      homeFailed: 'Couldn’t make a folder for your tasks', retry: 'Try again',
      ownFiles: 'Work with my files…', ownChange: 'Another folder…', backHome: 'Back to Meridian Studio',
      ownTitle: 'Work with your files', ownHint: 'Pick a folder with your files. Claude works on copies of the files in it and leaves the originals as they are.', ownPick: 'Choose a folder',
      inFolder: (n) => `Folder “${n}”`, reveal: 'Show in Finder', more: 'More',
      emptyTitle: 'What shall we make?', emptyHint: 'Describe the task in your own words or pick a suggestion. Claude shows every step, asks before it changes things and never sends anything out without you.',
      roles: { designer: 'Designer:', manager: 'Manager:', developer: 'Developer:', everyday: 'Try:' },
      starters: {
        designer: [
          { id: 'restyle', label: 'Restyle our site in our brand', need: 'site', ask: 'Which site?',
            prompt: (v) => `Restyle the site ${v} in our brand. Open it in the browser (it's already open next to Studio) and take a "before" screenshot. Take the colours and fonts from brand.json in this folder; if there is none, take the main colour from the site's logo and build a calm palette from it. Restyle it with this site's Boost (set_boost, CSS only) and take an "after" screenshot. Finish with 2–3 lines on what you changed.` },
          { id: 'board', label: 'Collect references into a board', need: 'text', ask: 'What is the board about?', placeholder: 'e.g. Scandinavian-style coffee shops',
            prompt: (v) => `Make a reference board about "${v}". Find 9–12 good examples on the web (sites, interiors, packaging — whatever fits). In the Drafts folder write board.html: a grid of cards — a picture (a direct image link), a short line on why it's good, and a link to the source; light background, tidy type. Publish nothing. Finish with one line on what you made.` },
          { id: 'audit', label: 'Find inconsistencies on a page', need: 'site', ask: 'Which page should I check?',
            prompt: (v) => `Check the page ${v} (open next to Studio) for design inconsistencies: different shades of one colour, different fonts and sizes on the same kind of element, different spacing and corner radii on similar blocks, buttons that don't match. Mark each one on the page with a pin: [[pin: <CSS selector> | <what's wrong, briefly>]] — at most 12. Change nothing. Finish with a list by importance.` },
        ],
        manager: [
          { id: 'report', label: 'Write a weekly report from our tasks', need: 'text', ask: 'Where are the tasks?', placeholder: 'a board link or a few words',
            prompt: (v) => `Write this week's report on the tasks: ${v}. In the Drafts folder make report.html: done, in progress, what's in the way — one page, no jargon. Send nothing anywhere.` },
          { id: 'compare', label: 'Compare two documents', need: 'text', ask: 'Which two documents?', placeholder: 'links or file names',
            prompt: (v) => `Compare two documents: ${v}. In the Drafts folder make compare.html: side by side, differences highlighted, a short summary of what changed on top.` },
          { id: 'agenda', label: 'Prepare a meeting agenda', need: 'text', ask: 'What is the meeting about?', placeholder: 'topic and who comes',
            prompt: (v) => `Prepare a meeting agenda: ${v}. In the Drafts folder make agenda.html: the goal, items with times, who prepares what, decisions to take.` },
        ],
        developer: [
          { id: 'bug', label: 'Find and fix a bug on the page', need: 'site', ask: 'On which page?',
            prompt: (v) => `On the page ${v} (open next to Studio) find what's broken: console errors, things that don't work or are misplaced. Pin each one [[pin: <selector> | <what's wrong>]] and suggest a fix; if it's our project in this folder, fix a copy in Drafts.` },
          { id: 'explain', label: 'Explain how this project works', need: '',
            prompt: () => 'Explain in plain words how the project in this folder works. In the Drafts folder make overview.html: what it is made of, how the parts connect (a diagram), where to start reading.' },
        ],
        everyday: [
          { id: 'read', label: 'Make the site easier to read', need: 'site', ask: 'Which site?',
            prompt: (v) => `Make the site ${v} easier to read with a Boost (CSS only): bigger text, calmer background, more line spacing, less distraction. Screenshots before and after.` },
          { id: 'notes', label: 'Collect notes from a page', need: 'site', ask: 'Which page?',
            prompt: (v) => `Collect the main points of the page ${v} into a note: in the Drafts folder make notes.html — the gist in 5–7 points, quotes with links.` },
        ],
      },
      starterGo: 'Start', starterOther: 'Another address…', starterNoTabs: 'Open the site in a tab or paste its address', starterCancel: 'Cancel',
      chips: {
        designer: ['Restyle our site in our brand', 'Collect references into a board', 'Find inconsistencies on a page'],
        manager: ['Write a weekly report from our tasks', 'Compare two documents', 'Prepare a meeting agenda'],
        developer: ['Find and fix a bug on the page', 'Explain how this project works'],
        everyday: ['Make the site easier to read', 'Collect notes from a page'],
      },
      allow: 'Allow', once: 'Just this once', no: 'No', allowed: 'Allowed', denied: 'Not allowed',
      answerInWorkbench: 'This one is answered in the Workbench', openWorkbench: 'Open Workbench',
      trustFailed: 'Couldn’t answer the folder question here — answer it in the Workbench',
      allowOnce: 'Allow', allowTask: 'Always allow for this task', whyAsk: 'Why are we asking?',
      qAsks: 'Claude asks', qOwn: 'In my own words — Workbench', qSend: 'Answer', qAnswered: 'Answer',
      filesTitle: 'Files from this task', created: 'new', changed: 'changed', shot: 'screenshot', shots: 'Snapshots', shotBefore: 'Before', shotAfter: 'After', wipeHint: 'before ← drag → after',
      siteBar: 'Result', showSite: 'Show the live site alongside', lastShot: 'latest snapshot', boostUndo: 'Boost · can be undone', boostUndone: 'Back as it was',
      before: 'Before', after: 'After', undo: 'Undo', undoTitle: 'Put the site back as it was before the task',
      working: 'Working…', waiting: 'Needs you', done: 'Done', idle: 'Done',
      busy: 'Claude is still working — I’ll send it when it’s done.', queued: 'Queued',
      startedInWorkbench: 'Started in the Workbench: here Claude edits files directly, without drafts.',
      showPage: 'Open alongside', pageAlongside: 'Open next to Studio — it changes along with the task.', outsideFolder: 'This file is outside the task’s folder: it can’t be shown here.',
      splitter: 'Chat width', tasksSplitter: 'Task list width', splitterHint: 'Drag to change the width; double-click to reset', taskView: 'Task',
      step: (i, n) => `step ${i} of ${n}`, noFiles: 'Files Claude creates or changes show up here.',
      resultEmpty: 'The result shows here: the site, pictures and documents it makes.',
      openFile: 'Show in folder', taskFallback: 'Untitled', notStarted: 'Couldn’t start Claude',
      details: 'Details', consent: 'Tasks are done by Claude from Anthropic: what you write and the files it looks at go to Anthropic.',
      consentOk: 'Got it, start',
      point: 'Point and say', pointTitle: 'Show on the page what to change: say it, or change it by hand', pointNoSite: 'Open the site alongside first',
      pointChip: 'Show on the page', pickTitle: 'Pick an element on the page — your message will be about it', unpick: 'Clear the pick',
      pinYes: (n, t) => `Yes, do what you suggested in pin ${n}: ${t}`, andMore: (n) => `and ${n} more`,
      handTitle: 'You changed by hand:', handNext: 'Claude hears about it with the next message.',
      handPrompt: (host, lines) => `I changed these by hand on ${host} (already in the Boost "Studio · ${host}"; don't overwrite it, keep it from now on):\n${lines}`,
      sayPrompt: (host, list, text) => `On ${host} I pointed at:\n${list}\n\n${text}\n\nChange only that (through a Boost on this site), leave the rest.`,
      brand: 'Brand', fromSite: 'from the site', readOnly: 'read only', palette: 'Palette', fonts: 'Fonts', fontSample: 'Fresh coffee', headings: 'headings', bodyText: 'text', remove: 'Remove',
      brandNone: 'No brand yet', brandNoneHint: 'Studio paints only with the brand’s colours and notices what on the site falls out of it.',
      brandFromSite: (h) => `Take colours and fonts from ${h}`, brandNeedSite: 'Open the site in a task first', brandRetake: 'Take again from the site', brandNoColors: 'No colours found on the page',
      brandCheck: 'Check the site against the brand', brandAllGood: 'Everything on the page is in brand colours.',
      driftTitle: (n) => `${n} colour${n === 1 ? '' : 's'} on the site ${n === 1 ? 'isn’t' : 'aren’t'} from the brand — replace?`,
      driftFix: 'Replace all', driftWhere: 'Show where', driftKeep: 'Keep',
      figmaOff: 'not connected', figmaOn: 'connected', figmaNotRunning: 'not connected — Figma isn’t answering', figmaOpen: 'Open Figma',
      figmaLinkHint: 'Paste a link to the file with the colours and fonts (Styles / Variables)',
      siteAddress: 'Site address', takeFromSite: 'Take from the site', siteBad: 'It needs a site address, like zerno.coffee', figmaConnect: 'Connect Figma', figmaLink: 'Link to the brand file in Figma', figmaTake: 'Take the brand',
      figmaHow: 'Open Figma on this computer and switch on, once: Figma menu → Preferences → Dev Mode MCP Server. Studio only reads designs.',
      figmaBadLink: 'It needs a link like https://www.figma.com/…',
      figmaPrompt: (l) => `Take the brand from Figma (read only, change nothing in Figma): ${l}\nFind the brand colours and fonts (variables and styles) and write them to brand.json in this folder as: {"source":"figma","name":"<name>","colors":[{"name":"<name>","value":"#RRGGBB"}],"fonts":[{"family":"<font>","use":"head" or "text"}]}. Say briefly what you found.`,
      cards: 'Cards', chat: 'Chat', allTasks: 'All tasks', all: 'All', inWork: 'Working', look: 'Look',
      handoff: 'Hand over to a developer', handoffHint: 'I’ll put together a description and the changes for a developer — nothing goes out without your yes', ownWords: 'Or in your own words…',
      taskCount: (n) => `${n} task${n === 1 ? '' : 's'}`,
      needsCount: (n) => `${n} need${n === 1 ? 's' : ''} you`, filesCount: (n) => `Files: ${n}`,
      handoffPrompt: 'Get this ready for the developers: in the Drafts folder write handoff.md — what changed and why, before and after screenshots, the exact colours, fonts and spacing, and which files of the site it touches. If the site is a git repository, prepare a branch with the changes and a draft pull request, but send or publish nothing without my yes. No jargon.',
      whoTitle: 'Who are you?', whoLead: 'Pick a hero — Meridian fits itself to your work. Change it any time.', skip: 'Skip',
      whoNote: 'The guess comes from the apps on this computer. Nothing is sent anywhere.', whoChange: 'Studio and the Workbench are always a click apart — this decides which opens first.',
      guess: 'Looks like you', roleChange: 'Who are you? Change the role',
      personas: {
        developer: { name: 'Developer', cls: 'Netrunner', role: 'code and agents', perks: [['term', 'Code and terminal in the Workbench'], ['cursor', 'Agents drive the browser'], ['grid', 'Every agent in Mission Control']], gets: 'Opens the <b>Workbench</b>', cta: 'I’m a developer — next' },
        designer: { name: 'Designer', cls: 'Enchantress', role: 'mockups and sites', perks: [['brush', 'Change the site in words'], ['drop', 'The Figma brand stays put'], ['undo', 'Every change can be undone']], gets: 'Opens <b>Studio</b>', cta: 'I’m a designer — next' },
        manager: { name: 'Manager', cls: 'Sorceress', role: 'tasks and reports', perks: [['doc', 'Reports from tasks, live'], ['shield', 'Nothing goes out without a yes'], ['split', 'Work and personal apart']], gets: 'Opens <b>Studio</b>', cta: 'I’m a manager — next' },
        everyday: { name: 'Just browsing', cls: 'Traveller', role: 'sites and mail', perks: [['tabs', 'Tabs that tidy themselves'], ['search', 'Find any open tab'], ['spark', 'AI only when asked']], gets: 'Opens <b>Studio</b>, nothing extra', cta: 'Just browsing — next' },
      },
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
          case 'screenshot': return say('camera', 'Снял скриншот', 'Took a screenshot', 'Снимаю скриншот', 'Taking a screenshot');
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
      const svc = server.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
      const nice = svc ? svc.charAt(0).toUpperCase() + svc.slice(1) : '';
      return say('puzzle', nice ? `Обратился к ${nice}` : 'Воспользовался подключённым сервисом', nice ? `Used ${nice}` : 'Used a connected service', nice ? `Обращаюсь к ${nice}` : 'Обращаюсь к сервису', nice ? `Using ${nice}` : 'Using a service');
    }
    switch (tool) {
      case 'Read': case 'NotebookRead': return say('file', `Посмотрел ${f || 'файл'}`, `Looked at ${f || 'a file'}`, `Смотрю ${f || 'файл'}`, `Looking at ${f || 'a file'}`);
      case 'Write': return say('pencil', `Создал файл ${f}`, `Created ${f}`, `Создаю файл ${f}`, `Creating ${f}`);
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return say('pencil', `Изменил ${f}`, `Changed ${f}`, `Меняю ${f}`, `Changing ${f}`);
      case 'Artifact': return say('globe', 'Опубликовал страницу', 'Published a page', 'Публикую страницу', 'Publishing a page');
      case 'ArtifactComments': return say('chat', 'Посмотрел комментарии к странице', 'Read the page’s comments');
      case 'ArtifactData': return say('layers', 'Обновил данные страницы', 'Updated the page’s data');
      case 'Skill': return say('sparkles', `Взял навык${i.skill ? `: ${clip(i.skill, 30)}` : ''}`, `Used a skill${i.skill ? `: ${clip(i.skill, 30)}` : ''}`);
      case 'ToolSearch': return say('search', 'Подготовил инструменты', 'Got its tools ready');
      case 'BashOutput': case 'KillShell': case 'KillBash': case 'TaskOutput': case 'TaskStop': return say('history', 'Проверил, как идёт работа', 'Checked on the work');
      case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': return say('layers', 'Обновил план', 'Updated the plan');
      case 'SlashCommand': return say('wand', 'Выполнил команду', 'Ran a command');
      case 'Glob': case 'Grep': case 'LS': return say('search', 'Поискал по файлам', 'Searched the files', 'Ищу по файлам', 'Searching the files');
      case 'WebFetch': return say('globe', `Открыл страницу ${site}`.trim(), `Opened ${site || 'a page'}`, `Открываю ${site}`.trim(), `Opening ${site || 'a page'}`);
      case 'WebSearch': return say('search', `Поискал в интернете: ${clip(i.query, 40)}`, `Searched the web: ${clip(i.query, 40)}`);
      case 'TodoWrite': return say('layers', 'Составил план', 'Made a plan');
      case 'Task': case 'Agent': return say('sparkles', `Позвал помощника: ${clip(i.description, 40)}`, `Asked a helper: ${clip(i.description, 40)}`);
      case 'Bash': case 'PowerShell': {
        const d = clip(i.description, 56) || cmdWords(i.command, ru);
        return d ? say('wand', d, d) : say('wand', 'Выполнил команду', 'Ran a command', 'Выполняю команду', 'Running a command');
      }
      case 'ExitPlanMode': return say('layers', 'Предложил план', 'Proposed a plan');
      case 'AskUserQuestion': {
        const q = clip(questionsOf(i)[0]?.question, 70);
        return q ? say('chat', `Спросил: ${q}`, `Asked: ${q}`, `Спрашивает: ${q}`, `Asking: ${q}`) : say('chat', 'Задал вопрос', 'Asked a question', 'Задаёт вопрос', 'Asking a question');
      }
      default: return say('sparkles', 'Работал над задачей', 'Worked on the task', 'Работаю над задачей', 'Working on the task');
    }
  }

  // A command in a few words, when Claude gave it no description.
  function cmdWords(cmd, ru) {
    const c = String(cmd || '').trim();
    if (!c) return '';
    const first = c.split(/\s+/)[0].replace(/^.*\//, '');
    const known = {
      npm: ['Запустил npm', 'Ran npm'], npx: ['Запустил инструмент', 'Ran a tool'], node: ['Запустил скрипт', 'Ran a script'], python3: ['Запустил скрипт', 'Ran a script'], python: ['Запустил скрипт', 'Ran a script'],
      git: ['Посмотрел историю изменений', 'Checked the history'], ls: ['Посмотрел, что в папке', 'Looked at the folder'], cat: ['Посмотрел файл', 'Looked at a file'],
      mkdir: ['Создал папку', 'Made a folder'], cp: ['Скопировал файлы', 'Copied files'], mv: ['Переместил файлы', 'Moved files'], open: ['Открыл файл', 'Opened a file'],
      curl: ['Скачал страницу', 'Fetched a page'], grep: ['Поискал по файлам', 'Searched the files'], rg: ['Поискал по файлам', 'Searched the files'], find: ['Поискал файлы', 'Looked for files'],
    };
    const k = known[first];
    return k ? (ru ? k[0] : k[1]) : '';
  }

  // The technical line under «Подробнее»: the tool and what it was given.
  function stepDetail(tool, input) {
    const i = input || {};
    const what = i.command || i.file_path || i.notebook_path || i.url || i.query || i.pattern || i.path || i.description || i.skill || '';
    return `${tool}${what ? ` · ${clip(what, 160)}` : ''}`;
  }

  // The questions of an AskUserQuestion, from its input (an object or its JSON,
  // which may come cut): [{question, header, multiSelect, options: [{label, description}]}].
  function questionsOf(input) {
    let i = input;
    if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = null; } }
    const qs = Array.isArray(i?.questions) ? i.questions : [];
    return qs.filter((q) => q && typeof q.question === 'string').map((q) => ({
      question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === 'string')
        .map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
    }));
  }

  // A permission question in plain words, saying what exactly: [title, detail].
  // «Разрешить: создать файл compare.html?»
  function askWords(tool, summary, lang) {
    const ru = lang === 'ru';
    const s = String(summary || '');
    const parts = s.split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts[parts.length - 2] : '';
    const file = clip(parts[parts.length - 1] || '', 60);
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool || '');
    const ask = (r, e) => (ru ? `Разрешить: ${r}?` : `Allow: ${e}?`);
    const where = folder ? (ru ? ` Папка ${folder}.` : ` Folder ${folder}.`) : '';
    if (tool === 'Write') {
      return [file ? ask(`создать файл ${file}`, `create the file ${file}`) : ask('создать файл', 'create a file'),
        (ru ? 'Новый файл, остальное не трогаю.' : 'A new file; nothing else is touched.') + where];
    }
    if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
      return [file ? ask(`изменить ${file}`, `change ${file}`) : ask('изменить файл', 'change a file'),
        (ru ? 'Всё можно вернуть.' : 'Everything can be undone.') + where];
    }
    if (tool === 'Read') return [file ? ask(`посмотреть ${file}`, `look at ${file}`) : ask('посмотреть файл', 'look at a file'), where.trim()];
    if (mcp && mcp[1].toLowerCase().includes('meridian')) {
      const n = mcp[2];
      if (n === 'set_boost') return [ask('перекрасить сайт', 'restyle the site'), ru ? 'Это Boost: меняется только вид у вас в браузере, его можно отменить одной кнопкой.' : 'It’s a Boost: only how it looks in your browser changes, and one button undoes it.'];
      if (n === 'navigate' || n === 'open_tab') return [ask(`открыть ${host(s) || 'сайт'}`, `open ${host(s) || 'a site'}`), s];
      if (n === 'click') return [ask('нажать на странице', 'click on the page'), ''];
      if (n === 'type_text') return [ask('ввести текст на странице', 'type on the page'), ''];
      return [ask('действие в браузере', 'a step in the browser'), ''];
    }
    if (mcp && mcp[1].toLowerCase().includes('figma')) return [ask('посмотреть макет в Figma', 'read the Figma file'), ru ? 'Только чтение: в Figma ничего не меняется.' : 'Read only: nothing changes in Figma.'];
    if (tool === 'Bash' || tool === 'PowerShell') {
      const c = clip(s.split('\n')[0], 48);
      return [c ? ask(`выполнить команду «${c}»`, `run the command “${c}”`) : ask('выполнить команду', 'run a command'), ru ? 'Команда целиком — в «Подробнее».' : 'The whole command is under Details.'];
    }
    if (tool === 'WebFetch') return [ask(`открыть ${host(s) || 'страницу'}`, `open ${host(s) || 'a page'}`), s];
    if (tool === 'WebSearch') return [ask(`поискать «${clip(s, 40)}»`, `search for “${clip(s, 40)}”`), ''];
    if (tool === 'ExitPlanMode') return [ru ? 'Claude предлагает план. Начинать?' : 'Claude has a plan. Start?', ''];
    if (mcp) {
      const svc = mcp[1].replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
      const nice = svc ? svc.charAt(0).toUpperCase() + svc.slice(1) : '';
      return [nice ? ask(`обратиться к ${nice}`, `use ${nice}`) : ask('обратиться к подключённому сервису', 'use a connected service'), s ? clip(s, 160) : ''];
    }
    if (tool === 'Task' || tool === 'Agent') return [ask('позвать помощника', 'ask a helper'), s ? clip(s, 160) : ''];
    return [ask('следующий шаг', 'the next step'), s ? clip(s, 160) : ''];
  }
  // Hand changes (CSS properties) in words.
  function handWords(props, lang) {
    const ru = lang === 'ru';
    const out = [];
    for (const [p, v] of Object.entries(props || {})) {
      if (p === 'background-color' || p === 'color') out.push(`${ru ? 'цвет' : 'colour'} ${v}`);
      else if (p === 'font-size') out.push(`${ru ? 'текст' : 'text'} ${v}`);
      else if (p === 'border-radius') out.push(`${ru ? 'скругление' : 'corners'} ${v}`);
      else if (/^padding-(left|right)$/.test(p)) { const t = `${ru ? 'отступы по бокам' : 'side spacing'} ${v}`; if (!out.includes(t)) out.push(t); }
      else if (/^padding-(top|bottom)$/.test(p)) { const t = `${ru ? 'отступы сверху и снизу' : 'top and bottom spacing'} ${v}`; if (!out.includes(t)) out.push(t); }
      else out.push(`${p} ${v}`);
    }
    return out;
  }

  // A permission card in friendly words: what Claude wants to do and why, what it can't touch, and why
  // Studio asks at all. `why`: Claude's own reason when there is one (the command's description, or
  // what it last said), else none. {kind, icon, title, why, safe, whyAsk}.
  function permWords(tool, summary, lang, why) {
    const ru = lang === 'ru';
    const s = String(summary || '');
    const file = clip(s.split('/').filter(Boolean).pop() || '', 60);
    const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool || '');
    const reason = clip(String(why || '').replace(/[.!…]+$/, ''), 140);
    const end = /[.!?…]$/.test(reason) ? '' : '.';
    const so = reason ? (ru ? `Зачем: ${lowerFirst(reason)}${end}` : `Why: ${lowerFirst(reason)}${end}`) : '';
    const inFolder = ru ? 'Меняется только папка этой задачи — ничего за её пределами.' : 'Only this task’s folder changes — nothing outside it.';
    const W = (kind, icon, title, safe, whyAsk) => ({ kind, icon, title, why: so, safe, whyAsk });
    if (tool === 'Write') {
      return W('create', 'file', ru ? `Claude хочет создать файл ${file || ''}`.trim() : `Claude wants to create ${file || 'a file'}`, inFolder,
        ru ? 'Studio спрашивает перед каждым новым файлом, чтобы на компьютере не появлялось ничего без вашего ведома.' : 'Studio asks before each new file so nothing appears on your computer without you knowing.');
    }
    if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
      return W('edit', 'pencil', ru ? `Claude хочет изменить ${file || 'файл'}` : `Claude wants to change ${file || 'a file'}`,
        ru ? 'Меняется копия в папке задачи, ваш оригинал остаётся как был. Всё можно вернуть.' : 'A copy in the task’s folder changes; your original stays as it was. Everything can be undone.',
        ru ? 'Изменения в файлах — то, что вы точно захотите увидеть заранее.' : 'Changes to files are something you’ll want to see coming.');
    }
    if (tool === 'Bash' || tool === 'PowerShell') {
      return W('run', 'terminal', ru ? 'Claude хочет выполнить команду на компьютере' : 'Claude wants to run a command on your computer',
        ru ? 'Сама команда — в «Подробнее». Если она вам незнакома, нажмите «Нет»: Claude найдёт другой путь.' : 'The command itself is under Details. If it looks unfamiliar, say No: Claude will find another way.',
        ru ? 'Команды могут менять что угодно на компьютере, поэтому каждую новую Studio показывает вам.' : 'Commands can change anything on the computer, so Studio shows you each new one.');
    }
    if (tool === 'WebFetch' || (mcp && mcp[1].toLowerCase().includes('meridian') && /^(navigate|open_tab)$/.test(mcp[2]))) {
      const h = host(s) || (ru ? 'сайт' : 'a site');
      return W('web', 'globe', ru ? `Claude хочет открыть ${h}` : `Claude wants to open ${h}`,
        ru ? 'Только посмотреть страницу: ничего не отправляется и не покупается.' : 'Only to look at the page: nothing is sent or bought.',
        ru ? 'Сайты видят, что их открыли, поэтому Studio спрашивает о новых адресах.' : 'Sites see they were opened, so Studio asks about new addresses.');
    }
    if (mcp && mcp[1].toLowerCase().includes('meridian') && mcp[2] === 'set_boost') {
      return W('style', 'palette', ru ? 'Claude хочет перекрасить сайт' : 'Claude wants to restyle the site',
        ru ? 'Меняется только вид у вас в браузере; одна кнопка возвращает как было.' : 'Only how it looks in your browser changes; one button puts it back.',
        ru ? 'Вы должны знать, когда сайт выглядит не так, как у всех.' : 'You should know when a site looks different from what everyone else sees.');
    }
    if (mcp && mcp[1].toLowerCase().includes('meridian')) {
      return W('browser', 'globe', ru ? 'Claude хочет действовать на открытой странице' : 'Claude wants to act on the open page',
        ru ? 'Нажать или ввести текст — только на этой странице.' : 'To click or type — on this page only.',
        ru ? 'Нажатия на сайте могут что-то отправить, поэтому Studio спрашивает.' : 'Clicks on a site can send something, so Studio asks.');
    }
    if (mcp && mcp[1].toLowerCase().includes('figma')) {
      return W('figma', 'palette', ru ? 'Claude хочет посмотреть макет в Figma' : 'Claude wants to look at the Figma file',
        ru ? 'Только чтение: в Figma ничего не меняется.' : 'Read only: nothing changes in Figma.',
        ru ? 'Макеты — ваша работа; Studio спрашивает, прежде чем их читать.' : 'Designs are your work; Studio asks before reading them.');
    }
    if (tool === 'Read') {
      return W('read', 'eye', ru ? `Claude хочет посмотреть ${file || 'файл'}` : `Claude wants to look at ${file || 'a file'}`,
        ru ? 'Только прочитать: файл не меняется.' : 'Only to read it: the file doesn’t change.',
        ru ? 'Этот файл вне папки задачи — поэтому спрашиваем.' : 'This file is outside the task’s folder — that’s why we ask.');
    }
    const [t] = askWords(tool, summary, lang);
    return W('other', 'sparkles', t.replace(/^(Разрешить|Allow):\s*/, ru ? 'Claude хочет: ' : 'Claude wants to: ').replace(/\?$/, ''), '',
      ru ? 'Studio спрашивает перед шагами, которые что-то меняют.' : 'Studio asks before steps that change things.');
  }
  function lowerFirst(t) { return t ? t.charAt(0).toLowerCase() + t.slice(1) : t; }

  // A task's name from the first message: its first sentence, a few words.
  function taskName(text) {
    const one = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s/)[0];
    if (one.length <= 48) return one;
    return `${one.slice(0, 47).replace(/[\s,.:;—-]+\S*$/, '')}…`;
  }

  const api = { T, taskName, permWords, stepWords, askWords, questionsOf, host, handWords, stepDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StudioWords = api;
})(typeof window !== 'undefined' ? window : globalThis);
