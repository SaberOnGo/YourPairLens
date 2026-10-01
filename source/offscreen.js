/* Plays a short two-note chime when an analysis finishes (offscreen document, AUDIO_PLAYBACK). */
'use strict';
chrome.runtime.onMessage.addListener(msg => {
  if (!msg || msg.pl !== 'chime') return;
  const ctx = new AudioContext();
  const notes = [[880, 0], [1320, 0.16]];
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + at); osc.stop(ctx.currentTime + at + 0.32);
  }
  setTimeout(() => ctx.close(), 800);
});
