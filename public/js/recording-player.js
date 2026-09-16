'use strict';

(function () {
  const cfg = window.RECORDING_PLAYER || { events: [], duration: 0 };
  const video = document.getElementById('player');
  const timeline = document.getElementById('timeline');
  const markers = document.getElementById('markers');
  const currentTime = document.getElementById('current-time');
  const durationEl = document.getElementById('duration');
  const playPause = document.getElementById('play-pause');
  const centerPlay = document.getElementById('center-play');
  const speed = document.getElementById('speed');
  const mute = document.getElementById('mute');
  const fullscreen = document.getElementById('fullscreen');
  const videoWrap = document.getElementById('video-wrap');
  const statusText = document.getElementById('status-text');
  const loading = document.getElementById('loading');
  const videoError = document.getElementById('video-error');
  const retry = document.getElementById('retry-btn');
  const eventsEl = document.getElementById('events');
  const shortcutsBtn = document.getElementById('shortcuts-btn');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const closeShortcuts = document.getElementById('close-shortcuts');

  const events = Array.isArray(cfg.events) ? cfg.events : [];
  let activeEvent = -1;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function fmt(sec) { sec = Math.max(0, Number(sec) || 0); const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60); return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
  function kind(type) { const t=String(type||'').toUpperCase(); if(t==='BUY')return'buy'; if(t==='SELL')return'sell'; if(t==='EXIT')return'exit'; return'info'; }
  function label(type) { return String(type||'EVENT').replace(/_/g,' '); }
  function setIcon(el, name) { const icon=el && el.querySelector('[data-lucide]'); if(icon) icon.setAttribute('data-lucide',name); if(window.lucide) window.lucide.createIcons(); }

  function renderEvents() {
    eventsEl.innerHTML = events.length ? events.map((e,i) => `
      <button type="button" data-event-index="${i}" class="event-row w-full text-left glass-tight rounded-xl px-3 py-2.5 flex items-center gap-3">
        <span class="event-dot ${kind(e.type)}"></span>
        <span class="min-w-0 flex-1"><span class="block text-[11px] font-semibold text-gray-200 truncate">${esc(label(e.type))}</span><span class="block text-[10px] text-gray-500 truncate mt-0.5">${esc(e.label || '')}${e.price != null ? ` · ${Number(e.price).toLocaleString('en-US',{maximumFractionDigits:2})}` : ''}</span></span>
        <span class="text-[10px] font-mono text-gray-500">${fmt(e.seconds)}</span>
      </button>`).join('') : '<div class="text-xs text-gray-500 italic p-4">No recorded events for this chunk.</div>';
  }

  function renderMarkers() {
    const d = Number(video.duration || cfg.duration || 0);
    if (!d || !markers) return;
    markers.innerHTML = events.map((e,i) => {
      const left = Math.max(0, Math.min(100, (Number(e.seconds || 0) / d) * 100));
      return `<button type="button" data-marker-index="${i}" class="event-marker ${kind(e.type)} pointer-events-auto" style="left:${left}%" title="${esc(label(e.type))} · ${fmt(e.seconds)}"></button>`;
    }).join('');
  }

  function updateTimeline() {
    const d=Number(video.duration || cfg.duration || 0), t=Number(video.currentTime||0);
    timeline.max = d || 0; timeline.value = t;
    const pct=d ? (t/d)*100 : 0; timeline.style.setProperty('--progress', `${pct}%`);
    currentTime.textContent=fmt(t); durationEl.textContent=fmt(d);
    let nearest=-1;
    events.forEach((e,i)=>{ if(Number(e.seconds||0)<=t+0.35) nearest=i; });
    if(nearest!==activeEvent) { activeEvent=nearest; document.querySelectorAll('[data-event-index]').forEach(x=>x.classList.toggle('active',Number(x.dataset.eventIndex)===nearest)); }
  }

  async function togglePlay() { try { if(video.paused) await video.play(); else video.pause(); } catch(_) {} }
  function seek(delta) { video.currentTime=Math.max(0,Math.min(Number(video.duration||cfg.duration||0),Number(video.currentTime||0)+delta)); }
  function jumpEvent(direction) {
    if(!events.length) return;
    const t=Number(video.currentTime||0);
    const index=direction>0 ? events.findIndex(e=>Number(e.seconds||0)>t+0.4) : [...events].map((e,i)=>({e,i})).reverse().find(x=>Number(x.e.seconds||0)<t-0.4)?.i;
    if(index != null && index >= 0) video.currentTime=Number(events[index].seconds||0);
  }
  function setPlayingUI() { const playing=!video.paused; setIcon(playPause,playing?'pause':'play'); setIcon(centerPlay,playing?'pause':'play'); centerPlay.classList.toggle('hidden',playing); statusText.textContent=playing ? `${speed.value}× playback` : 'Paused'; }
  function openShortcuts(){shortcutsModal.classList.remove('hidden');shortcutsModal.classList.add('flex');}
  function closeShortcutsModal(){shortcutsModal.classList.add('hidden');shortcutsModal.classList.remove('flex');}

  video.addEventListener('loadstart',()=>{loading.classList.remove('hidden');loading.classList.add('flex');videoError.classList.add('hidden');});
  video.addEventListener('loadedmetadata',()=>{loading.classList.add('hidden');loading.classList.remove('flex');renderMarkers();updateTimeline();});
  video.addEventListener('canplay',()=>{loading.classList.add('hidden');loading.classList.remove('flex');});
  video.addEventListener('error',()=>{loading.classList.add('hidden');loading.classList.remove('flex');videoError.classList.remove('hidden');statusText.textContent='Playback error';});
  video.addEventListener('timeupdate',updateTimeline);
  video.addEventListener('play',setPlayingUI);
  video.addEventListener('pause',setPlayingUI);
  video.addEventListener('ended',()=>{setPlayingUI();statusText.textContent='Recording complete';});

  timeline.addEventListener('input',()=>{video.currentTime=Number(timeline.value);updateTimeline();});
  playPause.addEventListener('click',togglePlay); centerPlay.addEventListener('click',togglePlay);
  document.getElementById('back-5').addEventListener('click',()=>seek(-5)); document.getElementById('forward-5').addEventListener('click',()=>seek(5));
  speed.addEventListener('change',()=>{video.playbackRate=Number(speed.value);if(!video.paused)statusText.textContent=`${speed.value}× playback`;});
  mute.addEventListener('click',()=>{video.muted=!video.muted;setIcon(mute,video.muted?'volume-x':'volume-2');});
  fullscreen.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await videoWrap.requestFullscreen();}catch(_) { if(video.requestFullscreen) video.requestFullscreen(); }});
  retry.addEventListener('click',()=>{videoError.classList.add('hidden');video.load();video.play().catch(()=>{});});
  eventsEl.addEventListener('click',e=>{const b=e.target.closest('[data-event-index]');if(b){const i=Number(b.dataset.eventIndex);video.currentTime=Number(events[i].seconds||0);video.play().catch(()=>{});}});
  markers.addEventListener('click',e=>{const b=e.target.closest('[data-marker-index]');if(b){const i=Number(b.dataset.markerIndex);video.currentTime=Number(events[i].seconds||0);video.play().catch(()=>{});}});
  shortcutsBtn.addEventListener('click',openShortcuts); closeShortcuts.addEventListener('click',closeShortcutsModal); shortcutsModal.addEventListener('click',e=>{if(e.target===shortcutsModal)closeShortcutsModal();});

  document.addEventListener('keydown',e=>{
    if(e.target && ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName) && e.key!==' ') return;
    if(e.code==='Space'){e.preventDefault();togglePlay();}
    else if(e.key==='ArrowLeft' && e.shiftKey){e.preventDefault();jumpEvent(-1);}
    else if(e.key==='ArrowRight' && e.shiftKey){e.preventDefault();jumpEvent(1);}
    else if(e.key==='ArrowLeft'){e.preventDefault();seek(-5);}
    else if(e.key==='ArrowRight'){e.preventDefault();seek(5);}
    else if(e.key==='ArrowUp'){e.preventDefault();const vals=[.25,.5,1,2,5,10,20],i=vals.indexOf(Number(speed.value));speed.value=String(vals[Math.min(vals.length-1,i+1)]);video.playbackRate=Number(speed.value);}
    else if(e.key==='ArrowDown'){e.preventDefault();const vals=[.25,.5,1,2,5,10,20],i=vals.indexOf(Number(speed.value));speed.value=String(vals[Math.max(0,i-1)]);video.playbackRate=Number(speed.value);}
    else if(e.key.toLowerCase()==='f'){e.preventDefault();fullscreen.click();}
    else if(e.key.toLowerCase()==='m'){e.preventDefault();mute.click();}
    else if(e.key==='Escape')closeShortcutsModal();
  });

  renderEvents();
  video.playbackRate=1;
  updateTimeline();
  if(window.lucide) window.lucide.createIcons();
})();
