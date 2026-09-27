const originalFetch = window.fetch;
window.fetch = function(url, ...args) {
  if (typeof url === 'string' && url.startsWith('/client-log')) {
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return Promise.resolve(new Response(''));
    }
  }
  return originalFetch.call(this, url, ...args);
};

if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

function unlockAudio() {
  getAudioContext();
}

const state = {
  targetWord: '',
  round: 1,
  maxRounds: 3,
  currentOptions: [],
  targetIndex: -1,
  hintCount: 0,
  eliminatedIndices: new Set(),
  isSoundEnabled: true,
  audioCtx: null,
  typingTarget: '',
  typingIndex: 0,
  isListening: false,
  recognition: null,
  kokoroTTS: null
};

function getAudioContext() {
  if (!state.audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      state.audioCtx = new AudioCtx();
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
  return state.audioCtx;
}

function playTone(freq, type = 'sine', duration = 0.2, startTimeOffset = 0, gainValue = 0.15) {
  if (!state.isSoundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime + startTimeOffset;
  
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(gainValue, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  
  osc.connect(gain);
  gain.connect(ctx.destination);
  
  osc.start(start);
  osc.stop(start + duration);
}

function playSuccessSound() {
  playTone(523.25, 'triangle', 0.15, 0);
  playTone(659.25, 'triangle', 0.15, 0.1);
  playTone(783.99, 'triangle', 0.25, 0.2);
}

function playWrongSound() {
  playTone(280, 'sine', 0.18, 0, 0.12);
  playTone(220, 'sine', 0.25, 0.12, 0.12);
}

function playHintSound() {
  playTone(587.33, 'sine', 0.12, 0);
  playTone(880.00, 'sine', 0.2, 0.08);
}

function playWinFanfare() {
  playTone(523.25, 'triangle', 0.15, 0);
  playTone(659.25, 'triangle', 0.15, 0.12);
  playTone(783.99, 'triangle', 0.15, 0.24);
  playTone(1046.50, 'triangle', 0.45, 0.36);
}

let currentSourceNode = null;
const audioCache = new Map();

function stopCurrentAudio() {
  if (currentSourceNode) {
    try {
      currentSourceNode.onended = null;
      currentSourceNode.stop();
    } catch (e) {}
    currentSourceNode = null;
  }
}

function playAudioBuffer(audioData, sampleRate = 24000, onEnded = null) {
  const ctx = getAudioContext();
  if (!ctx) {
    if (onEnded) onEnded();
    return;
  }
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  stopCurrentAudio();

  const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
  buffer.copyToChannel(audioData, 0);

  const gain = ctx.createGain();
  gain.gain.value = 1.8;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);
  if (onEnded) {
    source.onended = () => {
      onEnded();
    };
  }
  source.start(0);
  currentSourceNode = source;
}

window.onerror = function(msg, url, line, col, error) {
  fetch('/client-log?err=' + encodeURIComponent(msg + ' at ' + url + ':' + line + ' ' + (error ? error.stack : '')));
};
window.onunhandledrejection = function(e) {
  fetch('/client-log?rejection=' + encodeURIComponent(e.reason ? (e.reason.stack || e.reason.toString()) : e.toString()));
};

let isGeneratingAudio = false;

async function speak(text, onEnded = null) {
  fetch('/client-log?speak=' + encodeURIComponent(text + ' kokoro=' + !!state.kokoroTTS + ' sound=' + state.isSoundEnabled));
  if (!state.isSoundEnabled || !state.kokoroTTS) {
    if (onEnded) onEnded();
    return;
  }

  const key = text.trim();
  if (audioCache.has(key)) {
    const cached = audioCache.get(key);
    playAudioBuffer(cached.audioData, cached.sampleRate, onEnded);
    fetch('/client-log?played_cache=' + encodeURIComponent(key));
    return;
  }

  while (isGeneratingAudio) {
    await new Promise(r => setTimeout(r, 60));
  }

  isGeneratingAudio = true;
  try {
    fetch('/client-log?generating=' + encodeURIComponent(key));
    const audio = await state.kokoroTTS.generate(key, {
      voice: 'af_heart'
    });
    const item = { audioData: audio.audio, sampleRate: audio.sampling_rate || 24000 };
    audioCache.set(key, item);
    playAudioBuffer(item.audioData, item.sampleRate, onEnded);
    fetch('/client-log?played_fresh=' + encodeURIComponent(key));
  } catch (err) {
    fetch('/client-log?generate_err=' + encodeURIComponent(err.stack || err.toString()));
    if (onEnded) onEnded();
  } finally {
    isGeneratingAudio = false;
  }
}

async function speakHeardWord(word, onEnded = null) {
  fetch('/client-log?speak_heard=' + encodeURIComponent(word));
  const key = word.trim();
  const prefixKey = 'I heard the word';

  if (!state.isSoundEnabled || !state.kokoroTTS) {
    if (onEnded) onEnded();
    return;
  }

  const playWordAudio = (wordData, sampleRate) => {
    playAudioBuffer(wordData, sampleRate, onEnded);
  };

  const wordPromise = (async () => {
    if (audioCache.has(key)) {
      return audioCache.get(key);
    }
    while (isGeneratingAudio) {
      await new Promise(r => setTimeout(r, 40));
    }
    isGeneratingAudio = true;
    try {
      const audio = await state.kokoroTTS.generate(key, { voice: 'af_heart' });
      const item = { audioData: audio.audio, sampleRate: audio.sampling_rate || 24000 };
      audioCache.set(key, item);
      return item;
    } catch (e) {
      return null;
    } finally {
      isGeneratingAudio = false;
    }
  })();

  if (audioCache.has(prefixKey)) {
    const prefix = audioCache.get(prefixKey);
    playAudioBuffer(prefix.audioData, prefix.sampleRate, async () => {
      const wordItem = await wordPromise;
      if (wordItem) {
        playWordAudio(wordItem.audioData, wordItem.sampleRate);
      } else if (onEnded) {
        onEnded();
      }
    });
  } else {
    speak(`I heard the word ${key}!`, onEnded);
  }
}

function dismissLoading() {
  const loadingScreen = document.getElementById('loadingScreen');
  const setupView = document.getElementById('setupView');
  if (loadingScreen) {
    loadingScreen.classList.add('hidden');
    loadingScreen.style.display = 'none';
  }
  if (setupView) {
    setupView.classList.remove('hidden');
    setupView.style.display = 'flex';
  }
}

async function startAppLoading() {
  const progressBar = document.getElementById('loadingProgressBar');
  const statusText = document.getElementById('loadingStatusText');

  try {
    fetch('/client-log?step=start_import');
    const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
    fetch('/client-log?step=imported_kokoro');
    if (progressBar) progressBar.style.width = '20%';
    if (statusText) statusText.textContent = 'Loading Kokoro AI voice...';

    state.kokoroTTS = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p && typeof p.progress === 'number') {
          const pct = Math.round(p.progress * 100);
          if (progressBar) progressBar.style.width = `${Math.min(75, Math.max(20, pct))}%`;
          if (statusText) statusText.textContent = `Loading Kokoro model: ${pct}%`;
        }
      }
    });

    fetch('/client-log?step=kokoro_loaded');
    if (progressBar) progressBar.style.width = '85%';
    if (statusText) statusText.textContent = 'Finishing loading voice...';

    const introText = 'What word did you say? Tap the pink microphone button to say your word, or ask a grown-up to type it below.';
    try {
      const warmAudio = await state.kokoroTTS.generate(introText, { voice: 'af_heart' });
      audioCache.set(introText, { audioData: warmAudio.audio, sampleRate: warmAudio.sampling_rate || 24000 });
      const heardPrefix = await state.kokoroTTS.generate('I heard the word', { voice: 'af_heart' });
      audioCache.set('I heard the word', { audioData: heardPrefix.audio, sampleRate: heardPrefix.sampling_rate || 24000 });
      fetch('/client-log?step=voice_warm_done');
    } catch (warmErr) {
      fetch('/client-log?warm_err=' + encodeURIComponent(warmErr.toString()));
    }

    if (progressBar) progressBar.style.width = '100%';
    if (statusText) statusText.textContent = 'Ready!';

    dismissLoading();
  } catch (err) {
    fetch('/client-log?load_err=' + encodeURIComponent(err.stack || err.toString()));
    dismissLoading();
  }
}

const preheatQueue = [];
let isPreheating = false;

function queuePreheat(text) {
  const key = text.trim();
  if (audioCache.has(key) || preheatQueue.includes(key)) return;
  preheatQueue.push(key);
  processPreheatQueue();
}

async function processPreheatQueue() {
  if (isGeneratingAudio || isPreheating || !state.kokoroTTS || preheatQueue.length === 0) return;
  isPreheating = true;
  isGeneratingAudio = true;
  const text = preheatQueue.shift();
  if (!audioCache.has(text)) {
    try {
      const audio = await state.kokoroTTS.generate(text, { voice: 'af_heart' });
      audioCache.set(text, { audioData: audio.audio, sampleRate: audio.sampling_rate || 24000 });
    } catch (e) {}
  }
  isGeneratingAudio = false;
  isPreheating = false;
  if (preheatQueue.length > 0) {
    setTimeout(processPreheatQueue, 400);
  }
}

function precacheGame(targetWord) {
  if (!targetWord) return;
  const t = targetWord.toLowerCase();
  const firstLetter = t[0].toUpperCase();
  const lastLetter = t[t.length - 1].toUpperCase();
  const middleLetters = t.length > 2 ? t.slice(1, -1).toUpperCase() : t.toUpperCase();
  const middleSpaced = middleLetters.split('').join(' ');

  queuePreheat(`Let's type ${t}!`);
  queuePreheat(`Good job typing ${t}!`);
  queuePreheat(`Which word starts with ${firstLetter}?`);
  queuePreheat(`Correct! Starts with ${firstLetter}!`);
  queuePreheat(`Which word ends with ${lastLetter}?`);
  queuePreheat(`Correct! Ends with ${lastLetter}!`);
  queuePreheat(`Which word has ${middleSpaced} in the middle?`);
  queuePreheat(`Correct! ${t}!`);
  queuePreheat(`Yay! You red ${t}! Fantastic reading!`);
  queuePreheat('Try again!');
}

function sanitizeWord(input) {
  return input.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getDistractors(target, round) {
  const bank = (typeof window.WORD_BANK !== 'undefined') ? window.WORD_BANK : (typeof WORD_BANK !== 'undefined' ? WORD_BANK : []);
  const t = target.toLowerCase();
  const first = t[0];
  const last = t[t.length - 1];
  const len = t.length;

  function filterAndPick(filterFn, count = 2) {
    const candidates = bank.filter(filterFn);
    candidates.sort((a, b) => {
      const diffA = Math.abs(a.length - len);
      const diffB = Math.abs(b.length - len);
      if (diffA !== diffB) return diffA - diffB;
      return 0.5 - Math.random();
    });
    const picks = [];
    for (const w of candidates) {
      if (w !== t && !picks.includes(w)) {
        picks.push(w);
      }
      if (picks.length === count) break;
    }
    return picks;
  }

  if (round === 1) {
    return filterAndPick(w => w[0] !== first);
  }

  if (round === 2) {
    let picks = filterAndPick(w => w[0] === first && w[w.length - 1] !== last);
    if (picks.length < 2) {
      const fallback = filterAndPick(w => w[0] === first && w !== t);
      picks = [...picks, ...fallback].slice(0, 2);
    }
    return picks;
  }

  if (round === 3) {
    let picks = filterAndPick(w => w[0] === first && w[w.length - 1] === last && w !== t);
    if (picks.length < 2) {
      const fallback = filterAndPick(w => w[0] === first && w !== t);
      picks = [...picks, ...fallback].slice(0, 2);
    }
    return picks;
  }

  return [];
}

function renderWordHtml(word, round) {
  if (round === 1) {
    const firstChar = word[0];
    const rest = word.slice(1);
    return `<span class="char char-first highlight-r1">${firstChar}</span><span class="char">${rest}</span>`;
  }
  
  if (round === 2) {
    const start = word.slice(0, -1);
    const lastChar = word.slice(-1);
    return `<span class="char">${start}</span><span class="char char-last highlight-r2">${lastChar}</span>`;
  }

  if (round === 3) {
    if (word.length <= 2) {
      return `<span class="char char-middle highlight-r3">${word}</span>`;
    }
    const firstChar = word[0];
    const middle = word.slice(1, -1);
    const lastChar = word.slice(-1);
    return `<span class="char">${firstChar}</span><span class="char char-middle highlight-r3">${middle}</span><span class="char">${lastChar}</span>`;
  }

  return word;
}

function readCurrentDirections() {
  if (state.round === 1) {
    const firstLetter = state.targetWord[0].toUpperCase();
    speak(`Which word starts with ${firstLetter}?`);
  } else if (state.round === 2) {
    const lastLetter = state.targetWord[state.targetWord.length - 1].toUpperCase();
    speak(`Which word ends with ${lastLetter}?`);
  } else if (state.round === 3) {
    const middleLetters = state.targetWord.length > 2 ? state.targetWord.slice(1, -1).toUpperCase() : state.targetWord.toUpperCase();
    const middleSpaced = middleLetters.split('').join(' ');
    speak(`Which word has ${middleSpaced} in the middle?`);
  }
}

function updateRoundUI() {
  document.getElementById('stepDot1').className = 'step-dot' + (state.round === 1 ? ' active' : (state.round > 1 ? ' completed' : ''));
  document.getElementById('stepDot2').className = 'step-dot' + (state.round === 2 ? ' active' : (state.round > 2 ? ' completed' : ''));
  document.getElementById('stepDot3').className = 'step-dot' + (state.round === 3 ? ' active' : (state.round > 3 ? ' completed' : ''));
  
  document.getElementById('roundIndicator').textContent = `Round ${state.round} of ${state.maxRounds}`;

  const roundBadge = document.getElementById('roundBadge');
  const mainInstruction = document.getElementById('mainInstruction');
  const subInstruction = document.getElementById('subInstruction');
  const hintMessage = document.getElementById('hintMessage');
  
  hintMessage.classList.add('hidden');
  hintMessage.textContent = '';
  state.hintCount = 0;
  state.eliminatedIndices.clear();

  const firstLetter = state.targetWord[0].toUpperCase();
  const lastLetter = state.targetWord[state.targetWord.length - 1].toUpperCase();
  const middleLetters = state.targetWord.length > 2 ? state.targetWord.slice(1, -1).toUpperCase() : state.targetWord.toUpperCase();
  const middleSpaced = middleLetters.split('').join(' ');

  roundBadge.className = 'round-badge round-' + state.round;

  if (state.round === 1) {
    roundBadge.textContent = 'Round 1: First Letter';
    mainInstruction.textContent = `Which word starts with "${firstLetter}"?`;
    subInstruction.textContent = `Find the card starting with "${firstLetter}".`;
    speak(`Which word starts with ${firstLetter}?`);
  } else if (state.round === 2) {
    roundBadge.textContent = 'Round 2: Last Letter';
    mainInstruction.textContent = `All start with "${firstLetter}"! Which ends with "${lastLetter}"?`;
    subInstruction.textContent = `Look at the last letter highlighted in green.`;
    speak(`Which word ends with ${lastLetter}?`);
  } else if (state.round === 3) {
    roundBadge.textContent = 'Round 3: Middle Sound';
    mainInstruction.textContent = `Which word has "${middleLetters}" in the middle?`;
    subInstruction.textContent = `They start with "${firstLetter}" and end with "${lastLetter}". Check the middle!`;
    speak(`Which word has ${middleSpaced} in the middle?`);
  }

  const distractors = getDistractors(state.targetWord, state.round);
  const options = shuffle([state.targetWord, ...distractors]);
  state.currentOptions = options;
  state.targetIndex = options.indexOf(state.targetWord);

  for (let i = 0; i < 3; i++) {
    const card = document.getElementById(`card${i}`);
    card.className = 'word-card';
    if (options[i]) {
      card.innerHTML = renderWordHtml(options[i], state.round);
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  }
}

function handleCardClick(index) {
  if (state.eliminatedIndices.has(index)) return;

  const card = document.getElementById(`card${index}`);
  const chosenWord = state.currentOptions[index];

  if (chosenWord === state.targetWord) {
    card.classList.add('correct-pop');
    playSuccessSound();

    let praiseText = '';
    if (state.round === 1) {
      const firstLetter = state.targetWord[0].toUpperCase();
      praiseText = `Correct! Starts with ${firstLetter}!`;
    } else if (state.round === 2) {
      const lastLetter = state.targetWord[state.targetWord.length - 1].toUpperCase();
      praiseText = `Correct! Ends with ${lastLetter}!`;
    } else {
      praiseText = `Correct! ${state.targetWord}!`;
    }

    let advanced = false;
    const advanceNext = () => {
      if (advanced) return;
      advanced = true;
      if (state.round < state.maxRounds) {
        state.round += 1;
        updateRoundUI();
      } else {
        showWinScreen();
      }
    };

    speak(praiseText, () => {
      setTimeout(advanceNext, 500);
    });
    setTimeout(advanceNext, 3500);
  } else {
    card.classList.add('shake');
    playWrongSound();
    speak('Try again!');
    setTimeout(() => {
      card.classList.remove('shake');
    }, 500);
  }
}

function handleHint() {
  playHintSound();
  state.hintCount += 1;
  const hintMessage = document.getElementById('hintMessage');
  hintMessage.classList.remove('hidden');

  const firstLetter = state.targetWord[0].toUpperCase();
  const lastLetter = state.targetWord[state.targetWord.length - 1].toUpperCase();
  const middleLetters = state.targetWord.length > 2 ? state.targetWord.slice(1, -1).toUpperCase() : state.targetWord.toUpperCase();

  const targetCard = document.getElementById(`card${state.targetIndex}`);
  const targetHighlightSpan = targetCard.querySelector('.char-first, .char-last, .char-middle');
  if (targetHighlightSpan) {
    targetHighlightSpan.classList.add('pulse-target');
  }

  if (state.hintCount === 1) {
    let clue = '';
    if (state.round === 1) {
      clue = `Remember, ${state.targetWord.toUpperCase()} begins with "${firstLetter}". Look closely at letter 1!`;
    } else if (state.round === 2) {
      clue = `All cards begin with "${firstLetter}". ${state.targetWord.toUpperCase()} ends with "${lastLetter}"!`;
    } else {
      clue = `${state.targetWord.toUpperCase()} has "${middleLetters}" between "${firstLetter}" and "${lastLetter}".`;
    }
    hintMessage.textContent = clue;
    speak(clue);
    return;
  }

  const wrongIndices = [];
  for (let i = 0; i < state.currentOptions.length; i++) {
    if (i !== state.targetIndex && !state.eliminatedIndices.has(i)) {
      wrongIndices.push(i);
    }
  }

  if (wrongIndices.length > 0) {
    const toEliminate = wrongIndices[0];
    state.eliminatedIndices.add(toEliminate);
    const cardToEliminate = document.getElementById(`card${toEliminate}`);
    cardToEliminate.classList.add('eliminated');
    const wordEliminated = state.currentOptions[toEliminate];

    if (wrongIndices.length === 2) {
      const clue = `Hint: It is not "${wordEliminated}". 2 choices remaining!`;
      hintMessage.textContent = clue;
      speak(`It is not ${wordEliminated}. Try one of the other two!`);
    } else {
      const clue = `Final Hint: Only "${state.targetWord.toUpperCase()}" matches all sounds!`;
      hintMessage.textContent = clue;
      speak(`Only ${state.targetWord} is left! Tap it to finish!`);
    }
  }
}

function showWinScreen() {
  playWinFanfare();
  document.getElementById('gameView').classList.add('hidden');
  document.getElementById('typingView').classList.add('hidden');
  document.getElementById('setupView').classList.add('hidden');
  document.getElementById('winView').classList.remove('hidden');
  document.getElementById('winWordDisplay').textContent = state.targetWord.toUpperCase();
  speak(`Yay! You red ${state.targetWord}! Fantastic reading!`);
  launchConfetti();
}

function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6'];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 16,
      vy: (Math.random() - 0.7) * 18,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 10,
      opacity: 1
    });
  }

  let startTime = null;

  function render(time) {
    if (!startTime) startTime = time;
    const elapsed = time - startTime;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.rotation += p.vRot;
      if (elapsed > 2000) {
        p.opacity = Math.max(0, 1 - (elapsed - 2000) / 1500);
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.opacity;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }

    if (elapsed < 3500) {
      requestAnimationFrame(render);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(render);
}

function startGuidedTyping(word) {
  const cleaned = sanitizeWord(word);
  if (cleaned.length < 2) return;

  state.typingTarget = cleaned;
  state.typingIndex = 0;

  document.getElementById('setupView').classList.add('hidden');
  document.getElementById('gameView').classList.add('hidden');
  document.getElementById('winView').classList.add('hidden');
  document.getElementById('typingView').classList.remove('hidden');
  document.getElementById('homeBtn').classList.remove('hidden');

  document.getElementById('typingHeading').textContent = `Let's type ${cleaned.toUpperCase()}!`;

  const boxesContainer = document.getElementById('typingBoxes');
  boxesContainer.innerHTML = '';
  for (let i = 0; i < cleaned.length; i++) {
    const box = document.createElement('div');
    box.id = `typingBox${i}`;
    box.className = 'typing-box' + (i === 0 ? ' active' : '');
    box.textContent = cleaned[i].toUpperCase();
    boxesContainer.appendChild(box);
  }

  renderVirtualKeyboard();
  updateTypingPrompt();

  speak(`Let's type ${cleaned}!`);
}

function renderVirtualKeyboard() {
  const container = document.getElementById('virtualKeyboard');
  container.innerHTML = '';

  const rows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
  ];

  const targetChar = state.typingTarget[state.typingIndex] ? state.typingTarget[state.typingIndex].toUpperCase() : '';

  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keyboard-row';
    row.forEach(key => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'key-btn' + (key === targetChar ? ' target-key' : '');
      btn.setAttribute('data-key', key.toLowerCase());
      btn.textContent = key;
      btn.addEventListener('click', () => handleTypingInput(key.toLowerCase()));
      rowEl.appendChild(btn);
    });
    container.appendChild(rowEl);
  });
}

function updateTypingPrompt() {
  if (state.typingIndex >= state.typingTarget.length) return;
  const targetChar = state.typingTarget[state.typingIndex].toUpperCase();
  document.getElementById('typingKeyPrompt').innerHTML = `Find and press the letter <strong>${targetChar}</strong>`;
  
  for (let i = 0; i < state.typingTarget.length; i++) {
    const box = document.getElementById(`typingBox${i}`);
    if (i < state.typingIndex) {
      box.className = 'typing-box typed';
    } else if (i === state.typingIndex) {
      box.className = 'typing-box active';
    } else {
      box.className = 'typing-box';
    }
  }

  document.querySelectorAll('.key-btn').forEach(btn => {
    const key = btn.getAttribute('data-key');
    if (key === targetChar.toLowerCase()) {
      btn.classList.add('target-key');
    } else {
      btn.classList.remove('target-key');
    }
  });
}

function handleTypingInput(pressedChar) {
  if (!state.typingTarget || state.typingIndex >= state.typingTarget.length) return;
  const expectedChar = state.typingTarget[state.typingIndex].toLowerCase();

  if (pressedChar.toLowerCase() === expectedChar) {
    playTone(523.25 + state.typingIndex * 50, 'triangle', 0.14, 0);
    const box = document.getElementById(`typingBox${state.typingIndex}`);
    box.className = 'typing-box typed';
    state.typingIndex += 1;

    if (state.typingIndex < state.typingTarget.length) {
      updateTypingPrompt();
    } else {
      document.getElementById('typingKeyPrompt').innerHTML = `🎉 Super job! You typed <strong>${state.typingTarget.toUpperCase()}</strong>!`;
      precacheGame(state.typingTarget);
      let transitioned = false;
      const doTransition = () => {
        if (transitioned) return;
        transitioned = true;
        startWizard(state.typingTarget);
      };

      speak(`Good job typing ${state.typingTarget}!`, () => {
        setTimeout(doTransition, 600);
      });
      setTimeout(doTransition, 3500);
    }
  } else {
    playWrongSound();
    const box = document.getElementById(`typingBox${state.typingIndex}`);
    box.classList.add('shake');
    setTimeout(() => {
      box.classList.remove('shake');
    }, 450);
  }
}

function stopListening() {
  if (state.recognition) {
    try {
      state.recognition.abort();
    } catch (e) {}
    state.recognition = null;
  }
  state.isListening = false;
  const btn = document.getElementById('micBtn');
  const btnText = document.getElementById('micBtnText');
  if (btn) btn.classList.remove('listening');
  if (btnText) btnText.textContent = 'Tap to Say Word';
}

function startListening() {
  unlockAudio();
  stopListening();

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = document.getElementById('micStatus');
  const btn = document.getElementById('micBtn');
  const btnText = document.getElementById('micBtnText');

  if (!SpeechRec) {
    if (status) {
      status.textContent = 'Voice not supported in this browser. Please type the word below!';
      status.classList.remove('hidden');
    }
    return;
  }

  try {
    const rec = new SpeechRec();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-US';

    rec.onstart = () => {
      state.isListening = true;
      if (btn) btn.classList.add('listening');
      if (btnText) btnText.textContent = 'Listening... (Speak now)';
      if (status) {
        status.textContent = 'Listening... Speak a word out loud!';
        status.classList.remove('hidden');
      }
      fetch('/client-log?mic_started=1');
    };

    rec.onresult = (event) => {
      const spoken = event.results[0][0].transcript;
      const cleaned = sanitizeWord(spoken.split(' ')[0]);
      fetch('/client-log?heard=' + encodeURIComponent(spoken));

      if (cleaned.length >= 2) {
        if (status) status.textContent = `Heard: "${cleaned.toUpperCase()}"!`;
        const wordInput = document.getElementById('targetWordInput');
        if (wordInput) wordInput.value = cleaned;

        let moved = false;
        const goToTyping = () => {
          if (moved) return;
          moved = true;
          startGuidedTyping(cleaned);
          setTimeout(() => precacheGame(cleaned), 800);
        };

        speakHeardWord(cleaned, () => {
          setTimeout(goToTyping, 400);
        });
        setTimeout(goToTyping, 3500);
      } else {
        playWrongSound();
        if (status) status.textContent = 'Could not catch the word. Try again!';
        speak('Could not catch that word. Try again!');
      }
    };

    rec.onerror = (e) => {
      state.isListening = false;
      if (btn) btn.classList.remove('listening');
      if (btnText) btnText.textContent = 'Tap to Say Word';
      fetch('/client-log?mic_err=' + encodeURIComponent(e.error || 'unknown'));

      if (status) {
        if (e.error === 'no-speech') {
          status.textContent = 'No voice heard. Tap button and try again, or type below!';
        } else if (e.error === 'not-allowed') {
          status.textContent = 'Microphone permission needed. Allow Safari microphone access or type below!';
        } else {
          status.textContent = 'Could not catch voice. Try again or type below!';
        }
        status.classList.remove('hidden');
      }
    };

    rec.onend = () => {
      state.isListening = false;
      if (btn) btn.classList.remove('listening');
      if (btnText) btnText.textContent = 'Tap to Say Word';
      state.recognition = null;
    };

    state.recognition = rec;
    rec.start();
  } catch (err) {
    state.isListening = false;
    fetch('/client-log?mic_start_err=' + encodeURIComponent(err.message));
    if (status) {
      status.textContent = 'Microphone error. Please type the word below!';
      status.classList.remove('hidden');
    }
  }
}

function startWizard(word) {
  const cleaned = sanitizeWord(word);
  const errorEl = document.getElementById('inputError');

  if (cleaned.length < 2) {
    errorEl.textContent = 'Please enter a word with at least 2 letters.';
    errorEl.classList.remove('hidden');
    return;
  }

  errorEl.classList.add('hidden');
  state.targetWord = cleaned;
  state.round = 1;
  precacheGame(cleaned);

  document.getElementById('setupView').classList.add('hidden');
  document.getElementById('typingView').classList.add('hidden');
  document.getElementById('winView').classList.add('hidden');
  document.getElementById('gameView').classList.remove('hidden');
  document.getElementById('homeBtn').classList.remove('hidden');

  updateRoundUI();
}

function resetToHome() {
  window.speechSynthesis && window.speechSynthesis.cancel();
  stopListening();
  document.getElementById('setupView').classList.remove('hidden');
  document.getElementById('gameView').classList.add('hidden');
  document.getElementById('typingView').classList.add('hidden');
  document.getElementById('winView').classList.add('hidden');
  document.getElementById('homeBtn').classList.add('hidden');
  const input = document.getElementById('targetWordInput');
  input.value = '';
  input.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('wordForm');
  const input = document.getElementById('targetWordInput');
  const soundToggleBtn = document.getElementById('soundToggleBtn');
  const homeBtn = document.getElementById('homeBtn');
  const hintBtn = document.getElementById('hintBtn');
  const speakTargetBtn = document.getElementById('speakTargetBtn');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const speakDirectionsBtn = document.getElementById('speakDirectionsBtn');
  const speakSetupBtn = document.getElementById('speakSetupBtn');
  const speakTypingBtn = document.getElementById('speakTypingBtn');
  const micBtn = document.getElementById('micBtn');
  const teachTypeBtn = document.getElementById('teachTypeBtn');
  const skipTypingBtn = document.getElementById('skipTypingBtn');
  const skipLoadingBtn = document.getElementById('skipLoadingBtn');
  if (skipLoadingBtn) {
    skipLoadingBtn.addEventListener('click', dismissLoading);
  }

  document.addEventListener('pointerdown', () => {
    unlockAudio();
  }, { once: true });

  startAppLoading();

  const alwaysAllowMicBtn = document.getElementById('alwaysAllowMicBtn');
  const alwaysAllowMicText = document.getElementById('alwaysAllowMicText');

  function markMicAllowed() {
    if (alwaysAllowMicBtn) {
      alwaysAllowMicBtn.classList.add('allowed');
      if (alwaysAllowMicText) {
        alwaysAllowMicText.textContent = 'Mic Always Allowed';
      }
    }
  }

  if (localStorage.getItem('micAlwaysAllowed') === '1') {
    markMicAllowed();
  }

  if (alwaysAllowMicBtn) {
    alwaysAllowMicBtn.addEventListener('click', async () => {
      unlockAudio();
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Microphone not supported');
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.persistentMicStream = stream;
        localStorage.setItem('micAlwaysAllowed', '1');
        markMicAllowed();
        const status = document.getElementById('micStatus');
        if (status) {
          status.textContent = 'Microphone permission active! You can now speak words anytime.';
          status.classList.remove('hidden');
        }
        fetch('/client-log?mic_always_allowed=1');
      } catch (err) {
        fetch('/client-log?mic_always_err=' + encodeURIComponent(err.message));
        const status = document.getElementById('micStatus');
        if (status) {
          status.textContent = 'Safari tip: Choose Safari > Settings > Websites > Microphone > 127.0.0.1: Allow.';
          status.classList.remove('hidden');
        }
      }
    });
  }

  micBtn.addEventListener('click', () => {
    if (state.isListening) {
      stopListening();
    } else {
      stopCurrentAudio();
      startListening();
    }
  });

  teachTypeBtn.addEventListener('click', () => {
    const val = input.value || 'siren';
    startGuidedTyping(val);
  });

  skipTypingBtn.addEventListener('click', () => {
    startWizard(state.typingTarget);
  });

  speakSetupBtn.addEventListener('click', () => {
    speak('What word did you say? Tap the pink microphone button to say your word, or ask a grown-up to type it below.');
  });

  speakTypingBtn.addEventListener('click', () => {
    const targetChar = state.typingTarget[state.typingIndex] ? state.typingTarget[state.typingIndex].toUpperCase() : '';
    speak(`Find letter ${targetChar} on your keyboard.`);
  });

  speakDirectionsBtn.addEventListener('click', readCurrentDirections);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    startWizard(input.value);
  });

  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const word = btn.getAttribute('data-word');
      input.value = word;
      startWizard(word);
    });
  });

  for (let i = 0; i < 3; i++) {
    const card = document.getElementById(`card${i}`);
    card.addEventListener('click', () => handleCardClick(i));
  }

  hintBtn.addEventListener('click', handleHint);

  speakTargetBtn.addEventListener('click', () => {
    speak(state.targetWord);
  });

  soundToggleBtn.addEventListener('click', () => {
    state.isSoundEnabled = !state.isSoundEnabled;
    soundToggleBtn.textContent = state.isSoundEnabled ? '🔊' : '🔇';
    if (!state.isSoundEnabled && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  });

  homeBtn.addEventListener('click', resetToHome);
  playAgainBtn.addEventListener('click', resetToHome);

  window.addEventListener('keydown', (e) => {
    const typingView = document.getElementById('typingView');
    if (!typingView.classList.contains('hidden') && e.key.length === 1 && e.key.match(/[a-z]/i)) {
      handleTypingInput(e.key.toLowerCase());
    }
  });

  window.addEventListener('resize', () => {
    const canvas = document.getElementById('confettiCanvas');
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
  });
});
