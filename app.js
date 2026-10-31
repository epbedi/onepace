const $ = selector => document.querySelector(selector);
const dialog = $('#upload-dialog'); const form = $('#upload-form'); const fileInput = $('#file-input');
const player = $('#player'); let episodes = []; let selectedSeason = 1; let selectedId = null;
const CHUNK_SIZE = 5 * 1024 * 1024;

function prettySize(bytes) { if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 ** 2).toFixed(bytes >= 1024 ** 3 ? 1 : 0)} MB`; }
function openDialog() { $('#form-error').textContent = ''; dialog.showModal(); }
function closeDialog() { if (!$('#submit-upload').disabled) dialog.close(); }
$('#top-upload').addEventListener('click', openDialog); $('#empty-upload').addEventListener('click', openDialog); $('#add-nav').addEventListener('click', openDialog); $('#close-dialog').addEventListener('click', closeDialog);
fileInput.addEventListener('change', () => { const file = fileInput.files[0]; $('#file-label').innerHTML = file ? `<strong>${escapeHtml(file.name)}</strong> · ${prettySize(file.size)}` : 'Drop a video here or <u>browse files</u>'; });
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
const drop = $('#drop-zone');
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragover'); if (event.dataTransfer.files[0]) { fileInput.files = event.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); } });

async function loadEpisodes() {
  try { const response = await fetch('/api/episodes'); if (!response.ok) throw new Error('Could not load library.'); episodes = await response.json(); render(); }
  catch (error) { $('#form-error').textContent = error.message; }
}
function render() {
  const seasons = [...new Set(episodes.map(item => item.season))].sort((a, b) => a - b);
  $('#series-count').textContent = seasons.length; $('#episode-total').textContent = episodes.length;
  $('#empty').classList.toggle('hidden', episodes.length > 0); $('#collection').classList.toggle('hidden', episodes.length === 0);
  if (!episodes.length) return;
  if (!seasons.includes(selectedSeason)) selectedSeason = seasons[0];
  $('#season-select').innerHTML = seasons.map(season => `<option value="${season}" ${season === selectedSeason ? 'selected' : ''}>Season ${String(season).padStart(2, '0')}</option>`).join('');
  const visible = episodes.filter(item => item.season === selectedSeason).sort((a,b) => a.episode-b.episode);
  $('#season-meta').textContent = `${visible.length} ${visible.length === 1 ? 'EPISODE' : 'EPISODES'}`;
  $('#episode-list').innerHTML = visible.map(item => `<div class="episode-row ${item.id === selectedId ? 'selected' : ''}" data-id="${item.id}"><div class="episode-number">${String(item.episode).padStart(2, '0')}</div><div><div class="episode-title">${escapeHtml(item.title)}</div><div class="episode-file">${escapeHtml(item.fileName)} · ${prettySize(item.size)}</div></div><div class="episode-duration"><span class="play-small">▶</span></div></div>`).join('');
  document.querySelectorAll('.episode-row').forEach(row => row.addEventListener('click', () => playEpisode(row.dataset.id)));
}
$('#season-select').addEventListener('change', event => { selectedSeason = Number(event.target.value); render(); });
function playEpisode(id) {
  const item = episodes.find(ep => ep.id === id); if (!item) return; selectedId = id; render();
  $('#player').classList.remove('hidden'); $('.player-placeholder').classList.add('hidden');
  player.src = `/api/videos/${encodeURIComponent(id)}`; player.load(); player.play().catch(() => {});
  $('#now-title').textContent = item.title; $('#now-subtitle').textContent = `S${String(item.season).padStart(2,'0')} · E${String(item.episode).padStart(2,'0')}`;
}

form.addEventListener('submit', async event => {
  event.preventDefault(); const file = fileInput.files[0]; const errorBox = $('#form-error'); const submit = $('#submit-upload'); errorBox.textContent = '';
  if (!file) { errorBox.textContent = 'Choose a video file first.'; return; }
  const season = Number(form.elements.season.value); const episode = Number(form.elements.episode.value);
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) { errorBox.textContent = 'Season and episode must be positive numbers.'; return; }
  submit.disabled = true; $('#progress-area').classList.remove('hidden'); $('#progress-label').textContent = 'Preparing upload…'; updateProgress(0);
  try {
    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    let response = await fetch('/api/uploads/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, size: file.size, chunks, season, episode, title: form.elements.title.value }) });
    let result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not start upload.');
    const uploadId = result.uploadId;
    for (let i = 0; i < chunks; i++) {
      $('#progress-label').textContent = `Uploading · ${prettySize(Math.min(file.size, (i + 1) * CHUNK_SIZE))} of ${prettySize(file.size)}`;
      response = await fetch(`/api/uploads/${uploadId}/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE)) });
      result = await response.json(); if (!response.ok) throw new Error(result.error || `Chunk ${i + 1} failed.`);
      updateProgress(Math.round((i + 1) / chunks * 95));
    }
    $('#progress-label').textContent = 'Saving episode…';
    response = await fetch(`/api/uploads/${uploadId}/finish`, { method: 'POST' }); result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not finish upload.');
    updateProgress(100); selectedSeason = season; selectedId = result.id; await loadEpisodes();
    window.setTimeout(() => { dialog.close(); form.reset(); $('#file-label').innerHTML = 'Drop a video here or <u>browse files</u>'; $('#progress-area').classList.add('hidden'); updateProgress(0); }, 350);
  } catch (error) { errorBox.textContent = error.message; $('#progress-label').textContent = 'Upload stopped'; }
  finally { submit.disabled = false; }
});
function updateProgress(percent) { $('#progress-bar').style.width = `${percent}%`; $('#progress-percent').textContent = `${percent}%`; }
loadEpisodes();
