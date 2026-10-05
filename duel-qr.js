/* Bellashuv: QR taklif yaratish va QR skaner moduli.
 * - renderQr(): matn (havola) dan SVG QR kod chizadi (vendor/qrcode.js kerak).
 * - extractRoomCode(): skanerlangan matndan 8 belgili xona kodini ajratadi.
 * - createScanner(): kamera (BarcodeDetector yoki jsQR) va rasm orqali QR o‘qiydi.
 */
(() => {
  'use strict';

  const ROOM_CODE_RE = /^[A-Z0-9]{8}$/;
  const REJECT_MESSAGE = 'Bu QR kod duel xonasiga tegishli emas.';

  /* ---------- Xona kodini ajratish ---------- */
  function extractRoomCode(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const upper = raw.toUpperCase();
    if (ROOM_CODE_RE.test(upper)) return upper;
    try {
      const code = (new URL(raw).searchParams.get('room') || '').trim().toUpperCase();
      return ROOM_CODE_RE.test(code) ? code : '';
    } catch (_) {
      return '';
    }
  }

  /* ---------- QR chizish (SVG) ---------- */
  function renderQr(target, text) {
    if (!target) return false;
    if (typeof window.qrcode !== 'function') {
      target.textContent = '';
      return false;
    }
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(String(text), 'Byte');
      qr.make();
      const count = qr.getModuleCount();
      const quiet = 4;
      const size = count + quiet * 2;
      let path = '';
      for (let row = 0; row < count; row++) {
        let col = 0;
        while (col < count) {
          if (!qr.isDark(row, col)) { col++; continue; }
          const start = col;
          while (col < count && qr.isDark(row, col)) col++;
          path += `M${start + quiet} ${row + quiet}h${col - start}v1h-${col - start}z`;
        }
      }
      target.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Xonaga qo‘shilish QR kodi">` +
        `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#14122b"/></svg>`;
      return true;
    } catch (error) {
      console.error('QR kod yaratib bo‘lmadi.', error);
      target.textContent = '';
      return false;
    }
  }

  /* ---------- Yordamchi: jsQR ni faqat kerak bo‘lganda yuklash ---------- */
  let jsQrPromise = null;
  function ensureJsQR() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (!jsQrPromise) {
      jsQrPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'vendor/jsQR.js';
        script.async = true;
        script.onload = () => (typeof window.jsQR === 'function'
          ? resolve(window.jsQR)
          : reject(new Error('jsQR yuklanmadi')));
        script.onerror = () => {
          jsQrPromise = null;
          script.remove();
          reject(new Error('jsQR yuklanmadi'));
        };
        document.head.appendChild(script);
      });
    }
    return jsQrPromise;
  }

  /* ---------- Yordamchi: brauzerning o‘z QR detektori ---------- */
  let detectorPromise = null;
  function getDetector() {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        if (!('BarcodeDetector' in window)) return null;
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (!formats.includes('qr_code')) return null;
          return new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (_) {
          return null;
        }
      })();
    }
    return detectorPromise;
  }

  function cameraErrorMessage(error) {
    switch (error && error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Kameraga ruxsat berilmadi. Brauzer sozlamalarida ruxsat bering yoki rasmdan o‘qing.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'Kamera topilmadi. Rasmdan o‘qishni sinab ko‘ring.';
      case 'NotReadableError':
      case 'AbortError':
        return 'Kamera band yoki ishlamayapti. Boshqa ilovalarni yopib qayta urinib ko‘ring.';
      default:
        return 'Kamerani yoqib bo‘lmadi. Rasmdan o‘qishni sinab ko‘ring.';
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Rasm ochilmadi')); };
      image.src = url;
    });
  }

  /* ---------- Skaner ----------
   * onDetect(text) -> true bo‘lsa kod qabul qilindi (kamera to‘xtaydi).
   * onStatus(kind, message): kind = starting | scanning | info | warn | error
   */
  function createScanner({ video, onDetect, onStatus }) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const report = (kind, message) => { if (onStatus) onStatus(kind, message); };
    let stream = null;
    let timerId = 0;
    let running = false;
    let starting = false;
    let session = 0;
    let lastRejected = '';
    let lastRejectedAt = 0;

    async function decode(source, width, height, thorough) {
      if (!width || !height) return '';
      const detector = await getDetector();
      if (detector) {
        try {
          const codes = await detector.detect(source);
          if (codes && codes.length) return codes[0].rawValue || '';
          if (!thorough) return '';
        } catch (_) {
          /* detektor ishlamasa jsQR ga o‘tamiz */
        }
      }
      const scale = Math.min(1, (thorough ? 1200 : 640) / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const jsQR = await ensureJsQR();
      const hit = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: thorough ? 'attemptBoth' : 'dontInvert',
      });
      return hit && hit.data || '';
    }

    function releaseStream() {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      try { video.pause(); } catch (_) { /* e'tiborsiz */ }
      video.srcObject = null;
    }

    function stop() {
      session++;
      running = false;
      starting = false;
      clearTimeout(timerId);
      releaseStream();
    }

    async function tick(mySession) {
      if (!running || mySession !== session) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          const text = await decode(video, video.videoWidth, video.videoHeight, false);
          if (mySession !== session) return;
          if (text) {
            if (onDetect(text)) { stop(); return; }
            const now = Date.now();
            if (text !== lastRejected || now - lastRejectedAt > 2500) {
              lastRejected = text;
              lastRejectedAt = now;
              report('warn', REJECT_MESSAGE);
            }
          }
        } catch (error) {
          console.warn('QR kadrini o‘qishda xatolik.', error);
        }
      }
      if (running && mySession === session) timerId = setTimeout(() => tick(mySession), 120);
    }

    async function start() {
      if (running || starting) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        report('error', 'Kamera bu yerda ishlamaydi. Sahifani HTTPS orqali oching yoki rasmdan o‘qing.');
        return false;
      }
      const mySession = ++session;
      starting = true;
      report('starting', 'Kamera yoqilmoqda…');
      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (error) {
        if (mySession === session) { starting = false; report('error', cameraErrorMessage(error)); }
        return false;
      }
      if (mySession !== session) {
        newStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      if (!(await getDetector())) {
        try {
          await ensureJsQR();
        } catch (_) {
          newStream.getTracks().forEach((track) => track.stop());
          starting = false;
          report('error', 'QR o‘qish moduli yuklanmadi. Internetni tekshiring yoki kodni qo‘lda kiriting.');
          return false;
        }
        if (mySession !== session) {
          newStream.getTracks().forEach((track) => track.stop());
          return false;
        }
      }
      stream = newStream;
      video.muted = true;
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      try { await video.play(); } catch (_) { /* avtomatik ijro bloklansa ham kadrlar keladi */ }
      if (mySession !== session) return false;
      starting = false;
      running = true;
      lastRejected = '';
      report('scanning', 'QR kodni ramka ichiga joylashtiring.');
      tick(mySession);
      return true;
    }

    async function scanFile(file) {
      if (!file) return false;
      report('info', 'Rasm o‘qilmoqda…');
      let image;
      try {
        image = await loadImage(file);
      } catch (_) {
        report('error', 'Rasmni ochib bo‘lmadi. Boshqa rasm tanlang.');
        return false;
      }
      let text = '';
      try {
        text = await decode(image, image.naturalWidth, image.naturalHeight, true);
      } catch (error) {
        console.warn('Rasmdan QR o‘qib bo‘lmadi.', error);
      } finally {
        URL.revokeObjectURL(image.src);
      }
      if (!text) {
        report('error', 'Rasmda QR kod topilmadi. Aniqroq yoki kattaroq rasm tanlang.');
        return false;
      }
      if (!onDetect(text)) {
        report('warn', REJECT_MESSAGE);
        return false;
      }
      return true;
    }

    return { start, stop, scanFile, isActive: () => running || starting };
  }

  window.DuelQR = { extractRoomCode, renderQr, createScanner };
})();
