// channel.js — shared messaging between Presentation and Presenter
// Uses BroadcastChannel: works across tabs/windows in the SAME browser on localhost
//
// Messages sent by PRESENTER → PRESENTATION:
//   { type:'LASER_POS',   normX, normY }   — laser position (0-1)
//   { type:'HIGHLIGHT',   nx,ny,nw,nh }    — highlight box (normalised)
//   { type:'LASER_OFF' }                   — laser lost
//   { type:'CLEAR' }                       — clear all highlights
//   { type:'PING' }                        — heartbeat
//   { type:'SLIDE_NEXT' }                  — request next slide
//   { type:'SLIDE_PREV' }                  — request prev slide
//
// Messages sent by PRESENTATION → PRESENTER:
//   { type:'PONG', page, total }           — heartbeat reply + slide info
//   { type:'SLIDE_INFO', page, total, w, h } — slide dimensions for calibration

var ch = new BroadcastChannel('laserpresent-v3');

function chSend(msg) {
  try { ch.postMessage(msg); } catch(e) { console.warn('chSend fail', e); }
}
