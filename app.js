/* Golos prototype client.
   Сессия хранит posting-ключ в localStorage — только для локального прототипа. */

(() => {
  // Используем WebSocket-ноду (самая быстрая из списка Golos.id)
  const GOLOS_NODE = 'wss://ruapi.golos.today/ws';
  golos.config.set('websocket', GOLOS_NODE);

  const STORAGE_USER = 'golos_username';
  const STORAGE_KEY = 'golos_posting_key';
  const PAGE_SIZE = 10;

    const SCREENS = {
    feed: { title: 'Лента', id: 'screen-feed' },
    following: { title: 'Подписки', id: 'screen-following' },
    create: { title: 'Создать пост', id: 'screen-create' }, // <--- НОВОЕ
    blog: { title: 'Мой блог', id: 'screen-blog' },
    login: { title: 'Вход', id: 'screen-login' },
  };

  const state = {
    screen: 'feed',
    session: loadSession(),
    posts: new Map(),
    openPost: null,
    toastTimer: 0,
    loads: { feed: 0, following: 0, blog: 0 },
  };

  const ui = {
    createForm: document.getElementById('create-form'),
    postTitle: document.getElementById('post-title'),
    postBody: document.getElementById('post-body'),
    postTags: document.getElementById('post-tags'),
    createError: document.getElementById('create-error'),
    title: document.getElementById('screen-title'),
    chip: document.getElementById('session-chip'),
    loginDot: document.getElementById('login-dot'),
    loginForm: document.getElementById('login-form'),
    loginUser: document.getElementById('login-username'),
    loginKey: document.getElementById('login-key'),
    loginError: document.getElementById('login-error'),
    accountPanel: document.getElementById('account-panel'),
    accountName: document.getElementById('account-name'),
    viewer: document.getElementById('viewer'),
    viewerAuthor: document.getElementById('viewer-author'),
    viewerTitle: document.getElementById('viewer-title'),
    viewerMeta: document.getElementById('viewer-meta'),
    viewerBody: document.getElementById('viewer-body'),
    viewerComments: document.getElementById('viewer-comments'),
    viewerVote: document.getElementById('viewer-vote'),
    commentForm: document.getElementById('comment-form'),
    commentBody: document.getElementById('comment-body'),
    toast: document.getElementById('toast'),
  };

  /* ---------- Сессия ---------- */

  function loadSession() {
    const username = localStorage.getItem(STORAGE_USER) || '';
    const postingKey = localStorage.getItem(STORAGE_KEY) || '';
    return username && postingKey ? { username, postingKey } : null;
  }

  function saveSession(username, postingKey) {
    localStorage.setItem(STORAGE_USER, username);
    localStorage.setItem(STORAGE_KEY, postingKey);
    state.session = { username, postingKey };
    renderSession();
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_USER);
    localStorage.removeItem(STORAGE_KEY);
    state.session = null;
    renderSession();
  }

  function renderSession() {
    const name = state.session?.username;
    ui.chip.textContent = name ? `@${name}` : 'Гость';
    ui.chip.classList.toggle('is-in', Boolean(name));
    ui.loginDot.hidden = !name;
    ui.loginForm.hidden = Boolean(name);
    ui.accountPanel.hidden = !name;
    ui.accountName.textContent = name ? `@${name}` : '';
  }

  /* ---------- Навигация ---------- */

  function showScreen(name) {
    if (!SCREENS[name]) return;
    state.screen = name;
    closeViewer();

    Object.entries(SCREENS).forEach(([key, screen]) => {
      document.getElementById(screen.id).hidden = key !== name;
    });

    document.querySelectorAll('[data-nav]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.nav === name);
    });

    ui.title.textContent = SCREENS[name].title;

    if (name === 'feed') loadFeed();
    if (name === 'following') loadFollowing();
    if (name === 'blog') loadBlog();
    
    // НОВОЕ: Восстанавливаем черновик при входе на экран
    if (name === 'create') {
      ui.postTitle.value = localStorage.getItem('draft_title') || '';
      ui.postBody.value = localStorage.getItem('draft_body') || '';
      ui.postTags.value = localStorage.getItem('draft_tags') || 'golos, ru';
    }

  }

  /* ---------- Golos ---------- */

    function fetchDiscussions(sort, query) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Таймаут загрузки ленты. Проверьте интернет.')), 10000);
      const callback = (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(err);
        resolve(result);
      };

      if (sort === 'created') golos.api.getDiscussionsByCreated(query, callback);
      else if (sort === 'feed') golos.api.getDiscussionsByFeed(query, callback);
      else if (sort === 'blog') golos.api.getDiscussionsByBlog(query, callback);
      else reject(new Error('Неизвестный тип ленты'));
    });
  }

    function fetchReplies(author, permlink) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Таймаут загрузки комментариев.')), 10000);
      golos.api.getContentReplies(author, permlink, (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

    async function login(username, postingKeyWif) {
    const name = username.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,15}$/.test(name)) {
      throw new Error('Имя аккаунта Golos: 3–16 символов, латиница, цифры и дефис.');
    }

    if (!golos.auth.isWif(postingKeyWif.trim())) {
      throw new Error('Не удалось прочитать posting-ключ.');
    }

    // Запрашиваем аккаунт через WebSocket с таймаутом
    const accounts = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Таймаут соединения при входе')), 10000);
      golos.api.getAccounts([name], (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(err);
        resolve(result);
      });
    });

    const account = accounts[0];
    if (!account) throw new Error('Аккаунт не найден.');

    const publicKey = golos.auth.wifToPublic(postingKeyWif.trim()).toString();
    const matches = (account.posting?.key_auths || []).some(([key]) => key === publicKey);
    if (!matches) throw new Error('Ключ не входит в posting-полномочия этого аккаунта.');

    saveSession(name, postingKeyWif.trim());
  }

  function vote(author, permlink) {
  return new Promise((resolve, reject) => {
    const wif = state.session.postingKey;
    const voter = state.session.username;
    golos.broadcast.vote(wif, voter, author, permlink, 10000, (err, result) => {
      if (err) return reject(err);
      resolve(result);
      });
    });
  }

  function publishComment(parent, body) {
  return new Promise((resolve, reject) => {
    const wif = state.session.postingKey;
    const permlink = `re-${Date.now().toString(36)}`;
    const options = {
      parent_author: parent.author,
      parent_permlink: parent.permlink,
      author: state.session.username,
      permlink: permlink,
      title: '',
      body: body,
      json_metadata: JSON.stringify({ app: 'golos-proto/0.1.0' }),
    };
    golos.broadcast.comment(wif, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
      });
    });
  }

  function publishPost(title, body, tagsString) {
    return new Promise((resolve, reject) => {
      const wif = state.session.postingKey;
      const author = state.session.username;
      const permlink = `post-${Date.now().toString(36)}`;
      
      // Формируем массив тегов
      const tags = tagsString.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
      if (tags.length === 0) tags.push('golos'); // Если теги пустые, ставим дефолтный

      const jsonMetadata = {
        tags: tags,
        app: 'golos-proto/0.1.0'
      };

      const options = {
        parent_author: '', // Пустой автор означает, что это корневой пост
        parent_permlink: tags[0], // Первый тег становится категорией
        author: author,
        permlink: permlink,
        title: title,
        body: body,
        json_metadata: JSON.stringify(jsonMetadata)
      };

      golos.broadcast.comment(wif, options, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  /* ---------- Текст ---------- */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(source) {
    if (!source) return '';
    
    let fixedSource = source;
    // Ищем картинки, даже если между ![] и () есть переносы строк или пробелы
    fixedSource = fixedSource.replace(/!\[\s*\]\s*\(\s*(https?:\/\/[^)]+)\s*\)/g, '<img src="$1" loading="lazy" />');
    
    const rawHtml = marked.parse(fixedSource);
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'a', 'img', 'h1', 'h2', 'h3', 'center', 'div', 'span', 'iframe', 'hr'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'target', 'rel', 'loading', 'style', 'class', 'width', 'height', 'frameborder', 'allowfullscreen']
    });
  }

  //function renderMarkdown(source) {
    //const blocks = escapeHtml(source || '')
      //.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`)
      //.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
      //.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      //.replace(/^### (.+)$/gm, '<h3>$1</h3>')
      //.replace(/^## (.+)$/gm, '<h2>$1</h2>')
      //.replace(/^# (.+)$/gm, '<h1>$1</h1>')
      //.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
      //.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      //.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      //.replace(/`([^`]+)`/g, '<code>$1</code>')
      //.split(/\n{2,}/)
      //.map((block) => (/^<(h1|h2|h3|pre|blockquote)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`))
      //.join('');

    //return DOMPurify.sanitize(blocks, {
      //ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'a', 'img', 'h1', 'h2', 'h3'],
      //ALLOWED_ATTR: ['href', 'src', 'alt', 'target', 'rel', 'loading'],
    //});
  //}

  function previewText(body) {
    const plain = String(body || '')
      .replace(/!\[[^\]]*]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[#>*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return plain.length > 180 ? `${plain.slice(0, 180).trim()}…` : plain || 'Без текста';
  }

  function firstImage(post) {
    try {
      const meta = JSON.parse(post.json_metadata || '{}');
      const listed = Array.isArray(meta.image) ? meta.image.find((url) => /^https?:\/\//.test(url)) : '';
      if (listed) return listed;
    } catch {
      /* json_metadata бывает невалидным — карточка просто без картинки */
    }
    const match = String(post.body || '').match(/!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/);
    return match ? match[1] : '';
  }

  function formatTime(created) {
    const date = new Date(`${created}Z`);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} д`;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function payout(post) {
    const pending = Number.parseFloat(post.pending_payout_value) || 0;
    const paid = Number.parseFloat(post.total_payout_value) || 0;
    const curator = Number.parseFloat(post.curator_payout_value) || 0;
    return `$${(pending || paid + curator).toFixed(2)}`;
  }

  function errorText(error) {
    const raw = error?.message || error?.error || String(error || 'Неизвестная ошибка');
    const short = raw.replace(/^[\s\S]*Assert Exception:?/i, '').trim();
    return short.slice(0, 280);
  }

  function postKey(author, permlink) {
    return `${author}/${permlink}`;
  }

  /* ---------- Карточки и состояния ---------- */

  function screenRoot(name) {
    return document.getElementById(SCREENS[name].id);
  }

  function renderStatus(name, text, actionLabel) {
    const root = screenRoot(name);
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'state';
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    box.append(paragraph);
    if (actionLabel) {
      const button = document.createElement('button');
      button.className = 'primary';
      button.type = 'button';
      button.dataset.action = actionLabel === 'Войти' ? 'goto-login' : 'retry';
      button.dataset.screen = name;
      button.textContent = actionLabel;
      box.append(button);
    }
    root.append(box);
  }

  function renderLoading(name) {
    const root = screenRoot(name);
    root.replaceChildren();
    for (let index = 0; index < 4; index += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton';
      root.append(skeleton);
    }
  }

    function avatarUrl(username) {
    return `https://images.golos.today/u/${encodeURIComponent(username)}/avatar`;
  }

  function createCard(post) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.author = post.author;
    card.dataset.permlink = post.permlink;

    const imageUrl = firstImage(post);
    if (imageUrl) {
      const image = document.createElement('img');
      image.className = 'card-media';
      image.alt = '';
      image.loading = 'lazy';
      image.src = imageUrl;
      card.append(image);
    }

    const body = document.createElement('div');
    body.className = 'card-body';

    const head = document.createElement('header');
    head.className = 'card-head';
    head.append(createAvatar(post.author), createIdentity(post));
    body.append(head);

    const title = document.createElement('h2');
    title.textContent = post.title || 'Без названия';
    const preview = document.createElement('p');
    preview.className = 'preview';
    preview.textContent = previewText(post.body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      createActionButton('vote', 'Ап', post),
      createActionButton('open', `Комменты ${post.children || 0}`, post),
    );
    const reward = document.createElement('span');
    reward.className = 'payout';
    reward.textContent = payout(post);
    actions.append(reward);

    body.append(title, preview, actions);
    card.append(body);
    return card;
  }

  function createAvatar(username) {
    const image = document.createElement('img');
    image.className = 'avatar';
    image.alt = '';
    image.src = avatarUrl(username);
    
    // Если аватарка не загрузилась, делаем цветной кружок с буквой
    image.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'avatar';
      fallback.style.display = 'grid';
      fallback.style.placeItems = 'center';
      fallback.style.background = 'var(--surface-2)';
      fallback.style.color = 'var(--muted)';
      fallback.style.fontWeight = 'bold';
      fallback.textContent = username.charAt(0).toUpperCase();
      image.replaceWith(fallback);
    });
    return image;
  }

  function createIdentity(post) {
    const wrap = document.createElement('div');
    const author = document.createElement('p');
    author.className = 'author';
    author.textContent = `@${post.author}`;
    const time = document.createElement('p');
    time.className = 'time';
    time.textContent = formatTime(post.created);
    wrap.append(author, time);
    return wrap;
  }

  function createActionButton(action, label, post) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action === 'vote' ? 'up-btn' : 'quiet';
    button.dataset.action = action;
    button.dataset.author = post.author;
    button.dataset.permlink = post.permlink;
    button.textContent = label;
    return button;
  }

  function renderPosts(name, posts) {
    const root = screenRoot(name);
    root.replaceChildren();
    if (!posts.length) {
      renderStatus(name, 'Постов пока нет.', 'Обновить');
      return;
    }
    posts.forEach((post) => root.append(createCard(post)));
  }

  async function loadList(name, task) {
    const ticket = ++state.loads[name];
    renderLoading(name);
    try {
      const posts = await task();
      if (ticket !== state.loads[name]) return;
      renderPosts(name, posts);
    } catch (error) {
      if (ticket !== state.loads[name]) return;
      renderStatus(name, errorText(error), 'Обновить');
    }
  }

  function requireUser(name) {
    if (state.session) return true;
    renderStatus(name, 'Войдите, чтобы открыть этот раздел.', 'Войти');
    return false;
  }

  function loadFeed() {
    return loadList('feed', () => fetchDiscussions('created', { limit: PAGE_SIZE }).then((posts) => {
      posts.forEach((post) => state.posts.set(postKey(post.author, post.permlink), post));
      return posts;
    }));
  }
  
  function loadFollowing() {
    if (!requireUser('following')) return undefined;
    const username = state.session.username;
    // Передаем select_authors как массив
    return loadList('following', () => fetchDiscussions('feed', { select_authors: [username], limit: PAGE_SIZE }));
  }

  function loadBlog() {
    if (!requireUser('blog')) return undefined;
    const username = state.session.username;
    // Передаем select_authors как массив
    return loadList('blog', () => fetchDiscussions('blog', { select_authors: [username], limit: PAGE_SIZE }));
  }

  /* ---------- Просмотр поста ---------- */

  async function openPost(author, permlink) {
    const post = state.posts.get(postKey(author, permlink));
    if (!post) return;

    state.openPost = post;
    ui.viewer.hidden = false;
    ui.viewerTitle.textContent = post.title || 'Без названия';
    ui.viewerAuthor.textContent = `@${post.author}`;
    ui.viewerAuthor.href = `https://golos.id/@${post.author}/${post.permlink}`;
    ui.viewerMeta.textContent = `${formatTime(post.created)} · ${post.net_votes || 0} голосов · ${payout(post)}`;
    ui.viewerBody.innerHTML = renderMarkdown(post.body);
    ui.viewerVote.classList.remove('is-voted');
    ui.viewerVote.disabled = false;
    ui.commentBody.value = '';
    ui.viewerComments.replaceChildren(statusNode('Загружаем комментарии…'));

    try {
      renderComments(await fetchReplies(author, permlink));
    } catch (error) {
      ui.viewerComments.replaceChildren(statusNode(errorText(error)));
    }
  }

  function closeViewer() {
    state.openPost = null;
    ui.viewer.hidden = true;
  }

  function statusNode(text) {
    const paragraph = document.createElement('p');
    paragraph.className = 'meta';
    paragraph.textContent = text;
    return paragraph;
  }

  function renderComments(comments) {
    ui.viewerComments.replaceChildren();
    if (!comments?.length) {
      ui.viewerComments.append(statusNode('Комментариев пока нет.'));
      return;
    }

    comments.forEach((comment) => {
      const item = document.createElement('article');
      item.className = 'comment';
      const head = document.createElement('header');
      head.className = 'comment-head';
      head.append(createAvatar(comment.author), createIdentity(comment));
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = renderMarkdown(comment.body);
      item.append(head, body);
      ui.viewerComments.append(item);
    });
  }

  async function onVote(author, permlink, button) {
    if (!state.session) {
      showToast('Войдите, чтобы голосовать.');
      showScreen('login');
      return;
    }
    button.disabled = true;
    try {
      await vote(author, permlink);
      button.classList.add('is-voted');
      if (button === ui.viewerVote) button.textContent = 'Ап ✓';
      showToast('Голос отправлен.');
    } catch (error) {
      button.disabled = false;
      
      // Достаем сырой текст ошибки из блокчейна
      const rawError = error?.message || error?.error || String(error || '');
      
      // Проверяем, не является ли это ошибкой повторного голоса
      if (rawError.includes('already voted') || rawError.includes('similar way') || rawError.includes('2030000')) {
        showToast('Вы уже лайкнули этот пост 👍');
        // Делаем кнопку зеленой на всякий случай
        button.classList.add('is-voted');
        if (button === ui.viewerVote) button.textContent = 'Ап ✓';
      } else {
        // Если это какая-то другая ошибка, показываем её как есть
        showToast(errorText(error));
      }
    }
  }

  async function onCommentSubmit(event) {
    event.preventDefault();
    const body = ui.commentBody.value.trim();
    if (!state.openPost || !body) return;
    if (!state.session) {
      showToast('Войдите, чтобы комментировать.');
      showScreen('login');
      return;
    }

    const submit = ui.commentForm.querySelector('button');
    submit.disabled = true;
    try {
      await publishComment(state.openPost, body);
      ui.commentBody.value = '';
      showToast('Комментарий отправлен.');
      
      // Мгновенно показываем комментарий в интерфейсе
      ui.viewerComments.insertAdjacentHTML('afterbegin', `<article class="comment"><div class="comment-head"><img class="avatar" src="https://images.golos.today/u/${state.session.username}/avatar"><div class="identity"><p class="author">@${state.session.username}</p><p class="time">только что</p></div></div><div class="body">${renderMarkdown(body)}</div></article>`);
      
    } catch (error) {
      showToast(errorText(error));
    } finally {
      submit.disabled = false;
    }
  }

  function showToast(message) {
    ui.toast.hidden = false;
    ui.toast.textContent = message;
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      ui.toast.hidden = true;
    }, 3200);
  }

  /* ---------- События ---------- */

  function onAppClick(event) {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      showScreen(nav.dataset.nav);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action?.dataset.action === 'retry') {
      showScreen(action.dataset.screen);
      return;
    }
    if (action?.dataset.action === 'goto-login') {
      showScreen('login');
      return;
    }
    if (action?.dataset.action === 'vote') {
      event.stopPropagation();
      onVote(action.dataset.author, action.dataset.permlink, action);
      return;
    }

    const card = event.target.closest('.card');
    if (card) openPost(card.dataset.author, card.dataset.permlink);
  }

  ui.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.loginError.textContent = '';
    const submit = ui.loginForm.querySelector('button');
    submit.disabled = true;
    try {
      await login(ui.loginUser.value, ui.loginKey.value);
      ui.loginKey.value = '';
      showToast(`Вы вошли как @${state.session.username}`);
    } catch (error) {
      ui.loginError.textContent = errorText(error);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    clearSession();
    showToast('Сессия удалена с этого устройства.');
  });

  document.getElementById('viewer-back').addEventListener('click', closeViewer);
  ui.viewerVote.addEventListener('click', () => {
    if (!state.openPost) return;
    onVote(state.openPost.author, state.openPost.permlink, ui.viewerVote);
  });
  ui.commentForm.addEventListener('submit', onCommentSubmit);
  document.getElementById('app').addEventListener('click', onAppClick);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeViewer();
  });

  ui.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    
    // Проверка на авторизацию
    if (!state.session) {
      showToast('Войдите, чтобы создавать посты.');
      showScreen('login');
      return;
    }

    ui.createError.textContent = '';
    const submitBtn = ui.createForm.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Публикация...';

    try {
      await publishPost(ui.postTitle.value, ui.postBody.innerHTML, ui.postTags.value);
      showToast('Пост успешно опубликован! 🎉');
      
      // Очищаем форму
      ui.postTitle.value = '';
      ui.postBody.value = '';
      ui.postTags.value = 'golos, ru';
      
      // НОВОЕ: Очищаем черновик в памяти
      localStorage.removeItem('draft_title');
      localStorage.removeItem('draft_body');
      localStorage.removeItem('draft_tags');

      // Перекидываем пользователя в его блог, чтобы он увидел результат
      showScreen('blog');
    } catch (error) {
      ui.createError.textContent = errorText(error);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Опубликовать';
    }
  });

  // Автосохранение черновика
  function saveDraft() {
    localStorage.setItem('draft_title', ui.postTitle.value);
    localStorage.setItem('draft_body', ui.postBody.innerHTML); // <--- Берем HTML
    localStorage.setItem('draft_tags', ui.postTags.value);
  }

  // Слушатели, которые вызывают сохранение при каждом нажатии клавиши
  ui.postTitle.addEventListener('input', saveDraft);
  ui.postBody.addEventListener('input', saveDraft);
  ui.postTags.addEventListener('input', saveDraft);

  // Логика панели форматирования (WYSIWYG)
  document.querySelector('.editor-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    const format = btn.dataset.format;
    if (!format) return;

    // Фокусируемся на редакторе
    ui.postBody.focus();

    if (format === 'bold') document.execCommand('bold');
    if (format === 'italic') document.execCommand('italic');
    if (format === 'quote') document.execCommand('formatBlock', false, 'blockquote');
    
    saveDraft();
  });

  // Кнопка "Сохранить черновик"
  document.getElementById('save-draft-btn').addEventListener('click', () => {
    saveDraft();
    showToast('Черновик сохранен! 💾');
  });

  // Кнопка "Добавить фото" (Пока просто заглушка)
  document.getElementById('add-image-btn').addEventListener('click', () => {
    showToast('Загрузка фото появится на следующем этапе! 🖼️');
  });

  renderSession();
  showScreen('feed');
})();
